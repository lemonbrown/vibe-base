import type { FastifyInstance } from "fastify";
import type { AgentJob, JobEvent } from "@vibe/shared";
import { one, query } from "../db.js";
import { shortId } from "../lib/ids.js";
import { requireOwner } from "./guards.js";

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
}

function toAgentJob(row: JobRow): AgentJob {
  return {
    id: row.id,
    convId: row.conv_id,
    messageId: row.message_id,
    kind: row.kind as AgentJob["kind"],
    targetApp: row.target_app,
    instruction: row.instruction,
    claudeSessionId: row.claude_session_id,
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
       RETURNING id, conv_id, message_id, kind, target_app, instruction, claude_session_id`,
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

  // Finalize a job: set the authoritative answer, persist the claude session id
  // for multi-turn resume, and mark everything done/failed.
  app.post<{
    Params: { id: string };
    Body: { status?: "done" | "failed"; error?: string; claudeSessionId?: string; finalText?: string };
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
    if (req.body?.claudeSessionId) {
      await query("UPDATE conversations SET claude_session_id = $2, updated_at = now() WHERE id = $1", [
        job.conv_id,
        req.body.claudeSessionId,
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
