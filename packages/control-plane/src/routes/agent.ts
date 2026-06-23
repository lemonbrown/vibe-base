import type { FastifyInstance } from "fastify";
import type { AgentJob, JobEvent, LlmProvider, MachineStatus } from "@vibe/shared";
import { one, query } from "../db.js";
import { shortId } from "../lib/ids.js";
import { requireOwner } from "./guards.js";

/** A machine is considered online if it checked in within this window. */
const ONLINE_WINDOW_MS = 90_000;

const CLAIM_POLL_MS = 1000;
const CLAIM_TIMEOUT_MS = 25_000;

interface JobRow {
  id: string;
  conv_id: string;
  message_id: string | null;
  kind: string;
  target_app: string | null;
  instruction: string;
  claude_session_id: string | null;
  llm_provider: string;
  llm_model: string;
  plan_mode: boolean;
  stack_policy: string | null;
}

const PROVIDERS: LlmProvider[] = ["claude", "codex"];

function toProvider(value: string): LlmProvider {
  return (PROVIDERS as string[]).includes(value) ? (value as LlmProvider) : "claude";
}

function toAgentJob(row: JobRow): AgentJob {
  return {
    id: row.id,
    convId: row.conv_id,
    messageId: row.message_id,
    kind: row.kind as AgentJob["kind"],
    targetApp: row.target_app,
    instruction: row.instruction,
    llmProvider: toProvider(row.llm_provider),
    llmModel: row.llm_model || "sonnet",
    llmSessionId: row.claude_session_id,
    planMode: row.plan_mode,
    stackPolicy: row.stack_policy,
  };
}

/** Atomically claim the oldest queued job (safe across multiple daemons). */
async function claimNext(machineId: string): Promise<JobRow | null> {
  const res = await query<JobRow>(
    `UPDATE jobs SET status = 'claimed', machine_id = $1, claimed_at = now()
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, conv_id, message_id, kind, target_app, instruction, claude_session_id, llm_provider, llm_model, plan_mode, stack_policy`,
    [machineId]
  );
  return res.rows[0] ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // Register (or re-register) this machine. Idempotent by owner + name.
  app.post<{ Body: { name?: string } }>("/api/agent/register", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const name = (req.body?.name ?? "").trim() || "my-machine";
    const existing = await one<{ id: string }>(
      "SELECT id FROM machines WHERE owner_email = $1 AND name = $2",
      [actor.email, name]
    );
    if (existing) {
      await query("UPDATE machines SET last_seen_at = now() WHERE id = $1", [existing.id]);
      return reply.send({ machineId: existing.id, name });
    }
    const id = shortId("mch");
    await query(
      "INSERT INTO machines (id, owner_email, name, last_seen_at) VALUES ($1,$2,$3, now())",
      [id, actor.email, name]
    );
    return reply.send({ machineId: id, name });
  });

  // The owner's relay machine + whether its daemon is reachable. Drives the
  // chat's online/offline pill. Returns the most recently seen machine.
  app.get("/api/agent/status", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const row = await one<{ name: string; last_seen_at: Date | null }>(
      "SELECT name, last_seen_at FROM machines WHERE owner_email = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1",
      [actor.email]
    );
    const machine: MachineStatus | null = row
      ? {
          name: row.name,
          lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          online: !!row.last_seen_at && Date.now() - row.last_seen_at.getTime() < ONLINE_WINDOW_MS,
        }
      : null;
    return reply.send({ machine });
  });

  app.post<{ Body: { machineId?: string } }>("/api/agent/heartbeat", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    if (req.body?.machineId) {
      await query("UPDATE machines SET last_seen_at = now() WHERE id = $1 AND owner_email = $2", [
        req.body.machineId,
        actor.email,
      ]);
    }
    return reply.send({ ok: true });
  });

  // Long-poll for the next job. Returns 204 if none appears within the window.
  app.get<{ Querystring: { machine?: string } }>("/api/agent/jobs/claim", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const machineId = req.query.machine ?? "unknown";
    const deadline = Date.now() + CLAIM_TIMEOUT_MS;
    for (;;) {
      const job = await claimNext(machineId);
      if (job) return reply.send({ job: toAgentJob(job) });
      if (Date.now() >= deadline) return reply.code(204).send();
      await sleep(CLAIM_POLL_MS);
    }
  });

  // Append streamed events from the daemon and grow the assistant message.
  app.post<{ Params: { id: string }; Body: { events?: JobEvent[] } }>(
    "/api/agent/jobs/:id/events",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const job = await one<{ message_id: string | null; status: string }>(
        "SELECT message_id, status FROM jobs WHERE id = $1",
        [req.params.id]
      );
      if (!job) return reply.code(404).send({ error: "job not found" });

      const events = req.body?.events ?? [];
      if (!events.length) return reply.send({ ok: true });

      const seqRow = await one<{ next: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_events WHERE job_id = $1",
        [req.params.id]
      );
      let seq = Number(seqRow?.next ?? 1);
      let appended = "";
      for (const e of events) {
        await query(
          "INSERT INTO job_events (job_id, seq, type, data) VALUES ($1,$2,$3,$4)",
          [req.params.id, seq++, e.type, JSON.stringify(e.data ?? {})]
        );
        if (e.type === "text" && typeof e.data?.text === "string") appended += e.data.text;
      }

      if (job.status !== "running") {
        await query("UPDATE jobs SET status = 'running' WHERE id = $1", [req.params.id]);
      }
      if (appended && job.message_id) {
        await query(
          "UPDATE messages SET content = content || $2, status = 'streaming' WHERE id = $1",
          [job.message_id, appended]
        );
      }
      return reply.send({ ok: true });
    }
  );

  // Finalize a job: set the authoritative answer, persist the provider session id
  // for multi-turn resume, and mark everything done/failed.
  app.post<{
    Params: { id: string };
    Body: {
      status?: "done" | "failed";
      error?: string;
      claudeSessionId?: string;
      llmSessionId?: string;
      llmProvider?: string;
      finalText?: string;
    };
  }>("/api/agent/jobs/:id/complete", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const job = await one<{ conv_id: string; message_id: string | null }>(
      "SELECT conv_id, message_id FROM jobs WHERE id = $1",
      [req.params.id]
    );
    if (!job) return reply.code(404).send({ error: "job not found" });

    const status = req.body?.status === "failed" ? "failed" : "done";
    const finalText = req.body?.finalText;

    await query(
      "UPDATE jobs SET status = $2, error = $3, completed_at = now() WHERE id = $1",
      [req.params.id, status, req.body?.error ?? null]
    );
    if (job.message_id) {
      const msgStatus = status === "failed" ? "failed" : "done";
      if (typeof finalText === "string") {
        await query("UPDATE messages SET content = $2, status = $3 WHERE id = $1", [
          job.message_id,
          finalText,
          msgStatus,
        ]);
      } else {
        await query("UPDATE messages SET status = $2 WHERE id = $1", [job.message_id, msgStatus]);
      }
    }
    const sessionId = req.body?.llmSessionId ?? req.body?.claudeSessionId;
    if (sessionId) {
      await query("UPDATE conversations SET claude_session_id = $2, llm_provider = $3, updated_at = now() WHERE id = $1", [
        job.conv_id,
        sessionId,
        toProvider(req.body?.llmProvider ?? "claude"),
      ]);
    }
    // A terminal event so SSE listeners know to close.
    const seqRow = await one<{ next: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_events WHERE job_id = $1",
      [req.params.id]
    );
    await query("INSERT INTO job_events (job_id, seq, type, data) VALUES ($1,$2,'done',$3)", [
      req.params.id,
      Number(seqRow?.next ?? 1),
      JSON.stringify({ status, error: req.body?.error ?? null }),
    ]);
    return reply.send({ ok: true });
  });
}
