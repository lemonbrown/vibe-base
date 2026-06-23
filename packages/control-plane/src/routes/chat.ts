import type { FastifyInstance } from "fastify";
import type {
  ChatMessage,
  Conversation,
  ConversationDetail,
  JobKind,
} from "@vibe/shared";
import { one, query } from "../db.js";
import { shortId } from "../lib/ids.js";
import { requireUser } from "./guards.js";
import { loadOwnerSettings } from "./settings.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VALID_KINDS: JobKind[] = ["ask", "build", "adjust"];

interface ConvRow {
  id: string;
  owner_email: string;
  title: string;
  target_app: string | null;
  claude_session_id: string | null;
  llm_provider: string;
  created_at: Date;
  updated_at: Date;
}

function toConversation(r: ConvRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    targetApp: r.target_app,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Load a conversation the actor owns, or null. */
async function ownedConv(email: string, id: string): Promise<ConvRow | null> {
  return one<ConvRow>(
    "SELECT * FROM conversations WHERE id = $1 AND owner_email = $2",
    [id, email]
  );
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { title?: string; targetApp?: string } }>("/api/chat", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const id = shortId("cnv");
    await query(
      "INSERT INTO conversations (id, owner_email, title, target_app) VALUES ($1,$2,$3,$4)",
      [id, actor.email, req.body?.title?.trim() || "New chat", req.body?.targetApp ?? null]
    );
    const row = await ownedConv(actor.email, id);
    return reply.send({ conversation: toConversation(row!) });
  });

  app.get("/api/chat", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const res = await query<ConvRow>(
      "SELECT * FROM conversations WHERE owner_email = $1 ORDER BY updated_at DESC LIMIT 100",
      [actor.email]
    );
    return reply.send({ conversations: res.rows.map(toConversation) });
  });

  app.get<{ Params: { id: string } }>("/api/chat/:id", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const conv = await ownedConv(actor.email, req.params.id);
    if (!conv) return reply.code(404).send({ error: "conversation not found" });
    const msgs = await query<{
      id: string;
      role: string;
      content: string;
      status: string;
      created_at: Date;
    }>("SELECT id, role, content, status, created_at FROM messages WHERE conv_id = $1 ORDER BY created_at", [
      req.params.id,
    ]);
    const detail: ConversationDetail = {
      ...toConversation(conv),
      messages: msgs.rows.map(
        (m): ChatMessage => ({
          id: m.id,
          role: m.role as ChatMessage["role"],
          content: m.content,
          status: m.status as ChatMessage["status"],
          createdAt: m.created_at.toISOString(),
        })
      ),
    };
    return reply.send({ conversation: detail });
  });

  // Post a message -> record it, create a pending assistant message, and enqueue
  // a job for the owner's daemon to run with the selected local LLM.
  app.post<{
    Params: { id: string };
    Body: { content?: string; kind?: string; targetApp?: string; planMode?: boolean };
  }>("/api/chat/:id/messages", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const conv = await ownedConv(actor.email, req.params.id);
    if (!conv) return reply.code(404).send({ error: "conversation not found" });

    const content = (req.body?.content ?? "").trim();
    if (!content) return reply.code(400).send({ error: "content is required" });
    const kind = (VALID_KINDS as string[]).includes(req.body?.kind ?? "")
      ? (req.body!.kind as JobKind)
      : "ask";
    const targetApp = req.body?.targetApp ?? conv.target_app;

    // Snapshot the owner's settings onto the job so later edits never rewrite
    // in-flight work. The stack policy only applies where tech choices matter.
    const settings = await loadOwnerSettings(actor.email);
    const planMode =
      typeof req.body?.planMode === "boolean" ? req.body.planMode : settings.planModeDefault;
    const stackPolicy =
      (kind === "build" || kind === "adjust") && settings.stackPolicy.trim()
        ? settings.stackPolicy
        : null;

    const userMsgId = shortId("msg");
    const asstMsgId = shortId("msg");
    const jobId = shortId("job");

    await query(
      "INSERT INTO messages (id, conv_id, role, content, status) VALUES ($1,$2,'user',$3,'done')",
      [userMsgId, conv.id, content]
    );
    await query(
      "INSERT INTO messages (id, conv_id, role, content, status) VALUES ($1,$2,'assistant','','pending')",
      [asstMsgId, conv.id]
    );
    await query(
      `INSERT INTO jobs (
         id, conv_id, message_id, kind, target_app, instruction, claude_session_id,
         plan_mode, stack_policy, llm_provider, llm_model
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        jobId,
        conv.id,
        asstMsgId,
        kind,
        targetApp,
        content,
        conv.llm_provider === settings.llmProvider ? conv.claude_session_id ?? null : null,
        planMode,
        stackPolicy,
        settings.llmProvider,
        settings.llmModel,
      ]
    );

    // Title a fresh conversation from its first message.
    if (conv.title === "New chat") {
      await query("UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1", [
        conv.id,
        content.slice(0, 60),
      ]);
    } else {
      await query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conv.id]);
    }

    return reply.send({ jobId, userMessageId: userMsgId, assistantMessageId: asstMsgId });
  });

  // SSE: stream the latest job's events as the daemon produces them. Clients may
  // pass ?from=<seq> to resume after a reconnect.
  app.get<{ Params: { id: string }; Querystring: { from?: string } }>(
    "/api/chat/:id/stream",
    async (req, reply) => {
      const actor = await requireUser(req, reply);
      if (!actor) return;
      const conv = await ownedConv(actor.email, req.params.id);
      if (!conv) return reply.code(404).send({ error: "conversation not found" });
      const job = await one<{ id: string }>(
        "SELECT id FROM jobs WHERE conv_id = $1 ORDER BY created_at DESC LIMIT 1",
        [req.params.id]
      );
      if (!job) return reply.code(404).send({ error: "no jobs in this conversation" });

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
      let lastSeq = Number(req.query.from ?? 0) || 0;
      let idle = 0;

      while (active) {
        const evs = await query<{ seq: number; type: string; data: unknown }>(
          "SELECT seq, type, data FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq",
          [job.id, lastSeq]
        );
        for (const e of evs.rows) {
          reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          lastSeq = e.seq;
          if (e.type === "done") active = false;
        }
        if (!active) break;
        // Keep-alive comment every ~15s of silence so proxies don't drop us.
        if (evs.rows.length === 0 && ++idle >= 20) {
          reply.raw.write(": ping\n\n");
          idle = 0;
        }
        await sleep(750);
      }
      reply.raw.end();
    }
  );
}
