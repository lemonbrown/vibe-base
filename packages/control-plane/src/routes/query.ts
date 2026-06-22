import type { FastifyInstance, FastifyReply } from "fastify";
import { audit } from "../lib/audit.js";
import {
  AccessError,
  NotFoundError,
  appDetail,
  listAuditEvents,
  listReadModels,
  platformOverview,
  runReadModel,
} from "../services/query.js";
import { requireUser } from "./guards.js";

/** Map service errors to HTTP status codes. */
function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof AccessError) return reply.code(403).send({ error: err.message });
  return reply.code(400).send({ error: (err as Error).message });
}

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  // Stratum 1 — reason about the live platform.
  app.get("/api/platform/overview", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    return reply.send(await platformOverview(actor));
  });

  app.get<{ Params: { id: string } }>(
    "/api/platform/apps/:id",
    async (req, reply) => {
      const actor = await requireUser(req, reply);
      if (!actor) return;
      try {
        return reply.send(await appDetail(actor, req.params.id));
      } catch (err) {
        return fail(reply, err);
      }
    }
  );

  app.get<{ Querystring: { app?: string; action?: string; limit?: string } }>(
    "/api/platform/audit",
    async (req, reply) => {
      const actor = await requireUser(req, reply);
      if (!actor) return;
      const events = await listAuditEvents(actor, {
        appId: req.query.app,
        action: req.query.action,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.send({ events });
    }
  );

  // Stratum 2 — declared read-models over an app's own data.
  app.get<{ Params: { id: string } }>(
    "/api/platform/apps/:id/models",
    async (req, reply) => {
      const actor = await requireUser(req, reply);
      if (!actor) return;
      try {
        return reply.send({ models: await listReadModels(actor, req.params.id) });
      } catch (err) {
        return fail(reply, err);
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { model?: string; params?: Record<string, unknown> };
  }>("/api/platform/apps/:id/query", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const { model, params } = req.body ?? {};
    if (!model) return reply.code(400).send({ error: "model is required" });
    try {
      const result = await runReadModel(actor, req.params.id, model, params ?? {});
      // Record that a query ran — but never the param values or rows.
      await audit({
        actorEmail: actor.email,
        actorKind: actor.viaToken ? "llm" : "user",
        action: "app.data.query",
        appId: req.params.id,
        detail: { model, rows: result.rowCount },
      });
      return reply.send(result);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
