import type { FastifyInstance } from "fastify";
import type { AgentJob, JobEvent, LlmProvider, MachineStatus } from "@vibe/shared";
import { one, query } from "../db.js";
import { shortId } from "../lib/ids.js";
import { requireOwner } from "./guards.js";
import { loadOwnerSettings } from "./settings.js";

/** A machine is considered online if it checked in within this window. */
const ONLINE_WINDOW_MS = 90_000;

const CLAIM_POLL_MS = 1000;
const CLAIM_TIMEOUT_MS = 25_000;

interface JobRow {
  id: string;
  conv_id: string | null;
  message_id: string | null;
  kind: string;
  target_app: string | null;
  instruction: string;
  claude_session_id: string | null;
  llm_provider: string;
  llm_model: string;
  plan_mode: boolean;
  stack_policy: string | null;
  llm_reasoning_effort: string | null;
  owner_email: string | null;
}

const PROVIDERS: LlmProvider[] = ["claude", "codex"];

function toProvider(value: string): LlmProvider {
  return (PROVIDERS as string[]).includes(value) ? (value as LlmProvider) : "claude";
}

function toAgentJob(row: JobRow): AgentJob {
  return {
    id: row.id,
    convId: row.conv_id ?? "",
    messageId: row.message_id,
    kind: row.kind as AgentJob["kind"],
    targetApp: row.target_app,
    instruction: row.instruction,
    llmProvider: toProvider(row.llm_provider),
    llmModel: row.llm_model || "sonnet",
    llmSessionId: row.claude_session_id,
    planMode: row.plan_mode,
    stackPolicy: row.stack_policy,
    llmReasoningEffort: row.llm_reasoning_effort,
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
       RETURNING id, conv_id, message_id, kind, target_app, instruction, claude_session_id, llm_provider, llm_model, plan_mode, stack_policy, llm_reasoning_effort, owner_email`,
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

  // Daemon polls this to detect if its running job was cancelled by the user.
  app.get<{ Params: { id: string } }>("/api/agent/jobs/:id/status", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const job = await one<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [req.params.id]);
    if (!job) return reply.code(404).send({ error: "job not found" });
    return reply.send({ status: job.status, cancelling: job.status === "cancelling" });
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
      status?: "done" | "failed" | "stopped";
      error?: string;
      claudeSessionId?: string;
      llmSessionId?: string;
      llmProvider?: string;
      finalText?: string;
    };
  }>("/api/agent/jobs/:id/complete", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const job = await one<{ conv_id: string | null; message_id: string | null }>(
      "SELECT conv_id, message_id FROM jobs WHERE id = $1",
      [req.params.id]
    );
    if (!job) return reply.code(404).send({ error: "job not found" });

    const status =
      req.body?.status === "failed" ? "failed" :
      req.body?.status === "stopped" ? "stopped" : "done";
    const finalText = req.body?.finalText;

    await query(
      "UPDATE jobs SET status = $2, error = $3, completed_at = now() WHERE id = $1",
      [req.params.id, status, req.body?.error ?? null]
    );
    if (job.message_id) {
      const msgStatus = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done";
      // Only overwrite the message content if finalText is non-empty. When it is
      // empty (e.g. Claude's result field is "" because the response was all
      // thinking/tool blocks), preserve whatever was accumulated via streaming
      // text events rather than wiping it to blank and showing "…" in the portal.
      const hasContent = typeof finalText === "string" && finalText.trim().length > 0;
      if (hasContent && status !== "stopped") {
        await query("UPDATE messages SET content = $2, status = $3 WHERE id = $1", [
          job.message_id,
          finalText,
          msgStatus,
        ]);
      } else {
        await query("UPDATE messages SET status = $2 WHERE id = $1", [job.message_id, msgStatus]);
      }
    }
    // Only persist the session ID on clean completion — a stopped or failed
    // session leaves Claude in an interrupted state and resuming it on the
    // next message would immediately return "[Request interrupted by user]".
    const sessionId = req.body?.llmSessionId ?? req.body?.claudeSessionId;
    if (sessionId && job.conv_id && status === "done") {
      await query("UPDATE conversations SET claude_session_id = $2, llm_provider = $3, updated_at = now() WHERE id = $1", [
        job.conv_id,
        sessionId,
        toProvider(req.body?.llmProvider ?? "claude"),
      ]);
    } else if (status !== "done" && job.conv_id) {
      // Clear any existing interrupted session so the next job starts fresh.
      await query("UPDATE conversations SET claude_session_id = NULL WHERE id = $1", [job.conv_id]);
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

  // Receive the outcome of a post-deploy verify job. On failure, create an
  // adjust job so the daemon immediately gets to work on the fixes.
  app.post<{
    Params: { id: string };
    Body: {
      passed?: boolean;
      testOutput?: string;
      screenshotPaths?: Record<string, string>;
    };
  }>("/api/agent/jobs/:id/verify-complete", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const job = await one<{
      owner_email: string | null;
      target_app: string | null;
      instruction: string;
    }>("SELECT owner_email, target_app, instruction FROM jobs WHERE id = $1", [req.params.id]);
    if (!job) return reply.code(404).send({ error: "job not found" });

    const passed = req.body?.passed ?? false;
    await query("UPDATE jobs SET status = $2, completed_at = now() WHERE id = $1", [
      req.params.id,
      passed ? "done" : "failed",
    ]);

    if (passed) return reply.send({ ok: true, adjustJobId: null });

    // Tests failed — resolve the owner email (stored column or instruction JSON fallback).
    let ownerEmail = job.owner_email;
    if (!ownerEmail) {
      try {
        const parsed = JSON.parse(job.instruction) as { ownerEmail?: string };
        ownerEmail = parsed.ownerEmail ?? null;
      } catch {
        /* ignore */
      }
    }
    if (!ownerEmail || !job.target_app) return reply.send({ ok: true, adjustJobId: null });

    const settings = await loadOwnerSettings(ownerEmail);
    const testOutput = (req.body?.testOutput ?? "").slice(0, 6000);
    const screenshotPaths = req.body?.screenshotPaths ?? {};

    const screenshotNote = Object.entries(screenshotPaths)
      .map(([vp, p]) => `  ${vp}: ${p}`)
      .join("\n");

    const instruction = [
      `Playwright tests failed after deploying "${job.target_app}". Fix the issues, redeploy to test with \`vibe test\` or \`vibe ship\`, and promote with \`vibe promote\` after tests pass.`,
      "",
      "Test output:",
      testOutput,
      ...(screenshotNote
        ? ["", "Screenshots captured on this machine (available for visual inspection):", screenshotNote]
        : []),
    ].join("\n");

    const convId = shortId("cnv");
    await query(
      "INSERT INTO conversations (id, owner_email, title, target_app) VALUES ($1,$2,$3,$4)",
      [convId, ownerEmail, `Auto-verify: ${job.target_app}`, job.target_app]
    );
    const asstMsgId = shortId("msg");
    await query(
      "INSERT INTO messages (id, conv_id, role, content, status) VALUES ($1,$2,'assistant','','pending')",
      [asstMsgId, convId]
    );
    const adjustJobId = shortId("job");
    await query(
      `INSERT INTO jobs
         (id, conv_id, message_id, kind, target_app, instruction, owner_email,
          plan_mode, stack_policy, llm_provider, llm_model, llm_reasoning_effort)
       VALUES ($1,$2,$3,'adjust',$4,$5,$6,false,$7,$8,$9,$10)`,
      [
        adjustJobId, convId, asstMsgId, job.target_app, instruction, ownerEmail,
        settings.stackPolicy || null, settings.llmProvider, settings.llmModel,
        settings.llmReasoningEffort,
      ]
    );

    return reply.send({ ok: true, adjustJobId });
  });
}
