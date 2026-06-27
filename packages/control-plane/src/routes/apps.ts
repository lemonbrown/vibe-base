import type { FastifyInstance } from "fastify";
import { RegisterAppRequestSchema, validateReadModel } from "@vibe/shared";
import { query } from "../db.js";
import { audit } from "../lib/audit.js";
import { appSummary, getApp, listApps } from "../repo.js";
import { destroyApp } from "../services/teardown.js";
import { requireOwner, requireUser } from "./guards.js";

export async function appRoutes(app: FastifyInstance): Promise<void> {
  // Register a new app or update its manifest (idempotent upsert).
  app.post("/api/apps", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const parsed = RegisterAppRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const m = parsed.data.manifest;

    // Read-models become an executable surface, so reject malformed ones at the
    // door rather than storing SQL that would only fail (or worse) at query time.
    const modelProblems = m.readModels.flatMap(validateReadModel);
    if (modelProblems.length) {
      return reply.code(400).send({ error: `invalid read-models: ${modelProblems.join("; ")}` });
    }

    const existing = await getApp(m.id);
    if (
      !existing &&
      (await query("SELECT 1 FROM apps WHERE subdomain = $1", [
        m.domain.subdomain,
      ])).rowCount
    ) {
      return reply
        .code(409)
        .send({ error: `subdomain '${m.domain.subdomain}' is taken` });
    }

    await query(
      `INSERT INTO apps (id, name, description, visibility, access_mode, default_role, subdomain, manifest, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'registered')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         visibility = EXCLUDED.visibility,
         access_mode = EXCLUDED.access_mode,
         default_role = EXCLUDED.default_role,
         manifest = EXCLUDED.manifest,
         updated_at = now()`,
      [
        m.id,
        m.name,
        m.description,
        m.visibility,
        m.access.mode,
        m.access.defaultRole,
        m.domain.subdomain,
        JSON.stringify(m),
      ]
    );

    // Owner is always an active member with the owner role.
    await query(
      `INSERT INTO app_members (app_id, email, role, status)
       VALUES ($1, $2, 'owner', 'active')
       ON CONFLICT (app_id, email) DO UPDATE SET role = 'owner', status = 'active'`,
      [m.id, actor.email]
    );

    await audit({
      actorEmail: actor.email,
      action: existing ? "app.update" : "app.register",
      appId: m.id,
    });

    const row = await getApp(m.id);
    return reply.send({ app: await appSummary(row!) });
  });

  app.get("/api/apps", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const rows = await listApps();
    const apps = await Promise.all(rows.map((row) => appSummary(row)));
    return reply.send({ apps });
  });

  app.get<{ Params: { id: string } }>("/api/apps/:id", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const row = await getApp(req.params.id);
    if (!row) return reply.code(404).send({ error: "app not found" });
    return reply.send({ app: await appSummary(row) });
  });

  // Archive (soft). Hard delete requires ?confirm=<id> per spec §8.2.
  // Pass ?deleteRepo=true to also delete the linked GitHub repo and GHCR package.
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string; deleteRepo?: string } }>(
    "/api/apps/:id",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const row = await getApp(req.params.id);
      if (!row) return reply.code(404).send({ error: "app not found" });

      const hardDelete = req.query.confirm === req.params.id;
      if (hardDelete) {
        // Full teardown: container(s), database, storage, routing, records.
        await destroyApp(req.params.id, actor.email, {
          deleteGithub: req.query.deleteRepo === "true",
        });
        return reply.send({ deleted: true });
      }
      await query("UPDATE apps SET status = 'archived', updated_at = now() WHERE id = $1", [
        req.params.id,
      ]);
      await audit({
        actorEmail: actor.email,
        action: "app.archive",
        appId: req.params.id,
      });
      return reply.send({ archived: true });
    }
  );
}
