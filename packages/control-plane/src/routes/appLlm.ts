import type { FastifyInstance } from "fastify";
import type { LlmProvider, OwnerSettings } from "@vibe/shared";
import { one, query } from "../db.js";
import { shortId } from "../lib/ids.js";
import { requireOwner } from "./guards.js";
import { loadOwnerSettings } from "./settings.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL_ALIASES = ["fast", "smart", "deep"] as const;
type ModelAlias = (typeof MODEL_ALIASES)[number];

const MODEL_ALIAS_MAP: Record<LlmProvider, Record<ModelAlias, string>> = {
  claude: {
    fast: "claude-haiku-4-5-20251001",
    smart: "claude-sonnet-4-6",
    deep: "claude-opus-4-8",
  },
  codex: {
    fast: "gpt-5.4-mini",
    smart: "gpt-5.4",
    deep: "gpt-5.5",
  },
};

function normalizeModelAlias(value: unknown): ModelAlias | null {
  return typeof value === "string" && (MODEL_ALIASES as readonly string[]).includes(value)
    ? (value as ModelAlias)
    : null;
}

function modelForRequest(settings: OwnerSettings, alias: ModelAlias | null): string {
  if (!alias) return settings.llmModel;
  return MODEL_ALIAS_MAP[settings.llmProvider]?.[alias] ?? settings.llmModel;
}

/**
 * POST /api/apps/:id/llm
 *
 * Queues a `generate` job on behalf of a vibed app and streams the result back
 * as Server-Sent Events. The caller authenticates with the owner's bearer token
 * (Authorization: Bearer <token>), which the app server injects from the
 * VIBE_OWNER_TOKEN environment variable set at deploy time.
 *
 * Body: { prompt: string, systemPrompt?: string, model?: "fast"|"smart"|"deep" }
 *
 * The SSE stream emits the same JobEvent shape used by the portal chat stream:
 *   { seq, type: "text"|"thinking"|"status"|"error"|"done", data: {...} }
 *
 * The stream ends with a `done` event once the daemon finishes generation.
 */
export async function appLlmRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { prompt?: string; systemPrompt?: string; model?: string };
  }>("/api/apps/:id/llm", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const prompt = (req.body?.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const appRow = await one<{ id: string }>(
      "SELECT id FROM apps WHERE id = $1",
      [req.params.id]
    );
    if (!appRow) return reply.code(404).send({ error: "app not found" });

    const settings = await loadOwnerSettings(actor.email);
    const modelAlias = req.body?.model === undefined ? null : normalizeModelAlias(req.body.model);
    if (req.body?.model !== undefined && !modelAlias) {
      return reply.code(400).send({ error: "model must be one of: fast, smart, deep" });
    }
    const llmModel = modelForRequest(settings, modelAlias);

    // Prepend an optional caller-supplied system prompt so apps can set context
    // (e.g. "You are a Bible curriculum assistant") without polluting the instruction.
    const instruction = req.body?.systemPrompt
      ? `${req.body.systemPrompt.trim()}\n\n---\n\n${prompt}`
      : prompt;

    const jobId = shortId("job");
    await query(
      `INSERT INTO jobs
         (id, conv_id, message_id, kind, target_app, instruction, owner_email,
          plan_mode, stack_policy, llm_provider, llm_model, llm_reasoning_effort)
       VALUES ($1, NULL, NULL, 'generate', $2, $3, $4, false, $5, $6, $7, $8)`,
      [
        jobId,
        req.params.id,
        instruction,
        actor.email,
        settings.stackPolicy || null,
        settings.llmProvider,
        llmModel,
        settings.llmReasoningEffort,
      ]
    );

    // Stream job events as SSE until the daemon marks the job done.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    let active = true;
    req.raw.on("close", () => (active = false));
    let lastSeq = 0;
    let idle = 0;

    while (active) {
      const evs = await query<{ seq: number; type: string; data: unknown }>(
        "SELECT seq, type, data FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq",
        [jobId, lastSeq]
      );
      for (const e of evs.rows) {
        reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        lastSeq = e.seq;
        if (e.type === "done") active = false;
      }
      if (!active) break;
      if (evs.rows.length === 0 && ++idle >= 100) {
        reply.raw.write(": ping\n\n");
        idle = 0;
      }
      await sleep(150);
    }
    reply.raw.end();
  });
}
