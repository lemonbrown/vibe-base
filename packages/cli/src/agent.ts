import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import type { AgentJob, JobEvent, JobKind } from "@vibe/shared";
import { api } from "./client.js";
import { hasCredentials } from "./config.js";
import {
  loadAgentConfig,
  resolveAppPath,
  saveAgentConfig,
  type AgentConfig,
} from "./agentConfig.js";

function log(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------- claude stream-json parser -------------------- */

export interface ParsedLine {
  sessionId?: string;
  events: JobEvent[];
  final?: { text: string; isError: boolean };
}

/**
 * Parse one line of `claude --output-format stream-json`. Defensive: unknown or
 * malformed lines yield null rather than throwing, so a CLI format change never
 * crashes the daemon. `seq` is a placeholder (0) — the control plane assigns the
 * real sequence on ingest.
 */
export function parseStreamLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const events: JobEvent[] = [];
  let sessionId: string | undefined;
  let final: ParsedLine["final"];
  const type = obj.type as string | undefined;
  const sid = obj.session_id as string | undefined;
  if (sid) sessionId = sid;

  if (type === "system" && obj.subtype === "init") {
    events.push({ seq: 0, type: "status", data: { phase: "init", tools: obj.tools ?? [] } });
  } else if (type === "assistant" && obj.message) {
    const content = (obj.message as { content?: unknown[] }).content ?? [];
    for (const raw of content) {
      const block = raw as { type?: string; text?: string; name?: string; input?: unknown };
      if (block.type === "text" && block.text) {
        events.push({ seq: 0, type: "text", data: { text: block.text } });
      } else if (block.type === "tool_use") {
        events.push({ seq: 0, type: "tool", data: { name: block.name, input: block.input } });
      }
    }
  } else if (type === "result") {
    final = {
      text: typeof obj.result === "string" ? obj.result : "",
      isError: obj.is_error === true || obj.subtype === "error_max_turns",
    };
  }
  return { sessionId, events, final };
}

/* --------------------------- job execution ---------------------------- */

interface Plan {
  cwd: string;
  allowedTools: string[];
  permissionMode: string;
  preamble: string;
}

const READONLY_TOOLS = [
  "Read",
  "Bash(vibe platform:*)",
  "Bash(vibe query:*)",
  "Bash(vibe status:*)",
  "Bash(vibe apps:*)",
  "Bash(vibe context:*)",
  "Bash(vibe logs:*)",
];
const WRITE_TOOLS = ["Read", "Edit", "Write", "Bash"];

const ASK_PREAMBLE =
  "You are answering a question about the live Vibe Base platform and its apps. " +
  "Use the read-only `vibe` CLI to gather facts: `vibe platform` for an overview, " +
  "`vibe platform app <id>` for one app, and `vibe query <model> --app <id> -p k=v` " +
  "to read an app's data through its declared read-models (use `vibe query --app <id>` " +
  "to list them). Do NOT modify any files or deploy. Answer concisely.";

const BUILD_PREAMBLE =
  "You are building/updating a Vibe Base app. Follow AGENTS.md in this directory. " +
  "Use the `vibe` CLI for infrastructure and run `vibe ship` to deploy when ready. " +
  "Keep .vibe-memory/ up to date.";

/** Decide where to run and with what tools, creating dirs for new apps. */
async function planJob(job: AgentJob, cfg: AgentConfig): Promise<Plan> {
  const kind: JobKind = job.kind;
  if (kind === "ask") {
    await mkdir(cfg.workspaceRoot, { recursive: true });
    return {
      cwd: cfg.workspaceRoot,
      allowedTools: READONLY_TOOLS,
      permissionMode: "default",
      preamble: ASK_PREAMBLE,
    };
  }

  if (!job.targetApp) {
    throw new Error(`${kind} job has no target app`);
  }
  const { path } = resolveAppPath(cfg, job.targetApp);

  if (kind === "build") {
    await mkdir(path, { recursive: true });
    // Remember where we put it so later adjust/ask jobs find the same dir.
    if (!cfg.apps[job.targetApp]) {
      cfg.apps[job.targetApp] = path;
      await saveAgentConfig(cfg);
    }
  } else if (!(await exists(path))) {
    throw new Error(
      `app "${job.targetApp}" has no local directory at ${path} — link it with \`vibe agent link ${job.targetApp} <path>\``
    );
  }

  return {
    cwd: path,
    allowedTools: WRITE_TOOLS,
    permissionMode: "acceptEdits",
    preamble: BUILD_PREAMBLE,
  };
}

/**
 * Run one job: spawn `claude` in the resolved directory, stream its events back
 * to the control plane, and finalize with the session id + final answer.
 */
async function runJob(job: AgentJob, cfg: AgentConfig): Promise<void> {
  let plan: Plan;
  try {
    plan = await planJob(job, cfg);
  } catch (err) {
    await api.completeJob(job.id, { status: "failed", error: (err as Error).message });
    log(`  ✗ ${(err as Error).message}`);
    return;
  }

  const prompt = `${plan.preamble}\n\n---\n\n${job.instruction}`;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    plan.permissionMode,
    "--allowedTools",
    plan.allowedTools.join(","),
  ];
  if (job.claudeSessionId) args.push("--resume", job.claudeSessionId);

  log(`  → claude (${job.kind}) in ${plan.cwd}`);

  let sessionId: string | undefined = job.claudeSessionId ?? undefined;
  let finalText = "";
  let failed = false;

  // Batch events so we don't POST on every single line.
  let queue: JobEvent[] = [];
  let flushing = Promise.resolve();
  const flush = async (): Promise<void> => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      await api.postJobEvents(job.id, batch);
    } catch {
      /* best-effort; the next flush or completion carries on */
    }
  };
  const enqueue = (events: JobEvent[]): void => {
    if (!events.length) return;
    queue.push(...events);
    if (queue.length >= 8) flushing = flushing.then(flush);
  };

  await new Promise<void>((resolveRun) => {
    const child = spawn("claude", args, { cwd: plan.cwd, shell: false });
    const ticker = setInterval(() => {
      flushing = flushing.then(flush);
    }, 500);

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const parsed = parseStreamLine(line);
      if (!parsed) return;
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.events.length) enqueue(parsed.events);
      if (parsed.final) {
        finalText = parsed.final.text;
        failed = parsed.final.isError;
      }
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearInterval(ticker);
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "`claude` CLI not found on PATH — install it and log in with your subscription."
          : err.message;
      finalText = finalText || msg;
      failed = true;
      stderr += msg;
      resolveRun();
    });

    child.on("close", (code) => {
      clearInterval(ticker);
      if (code !== 0 && !finalText) {
        finalText = stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`;
        failed = true;
      }
      resolveRun();
    });
  });

  // Final flush, then finalize.
  await flushing;
  await flush();
  await api.completeJob(job.id, {
    status: failed ? "failed" : "done",
    error: failed ? finalText.slice(0, 2000) : undefined,
    claudeSessionId: sessionId,
    finalText,
  });
  log(failed ? "  ✗ job failed" : "  ✓ job done");
}

/* ------------------------------- daemon ------------------------------- */

export async function runDaemon(opts: { name?: string } = {}): Promise<void> {
  if (!(await hasCredentials())) {
    throw new Error(
      "Not logged in. Run `vibe login --url <url> --token <token>` before `vibe agent`."
    );
  }
  const cfg = await loadAgentConfig();
  await mkdir(cfg.workspaceRoot, { recursive: true });

  const name = opts.name ?? cfg.machineName ?? hostname();
  const { machineId } = await api.registerAgent(name);
  cfg.machineId = machineId;
  cfg.machineName = name;
  await saveAgentConfig(cfg);

  log(`vibe agent "${name}" (${machineId})`);
  log(`workspace: ${cfg.workspaceRoot}`);
  log("Waiting for jobs… (Ctrl-C to stop)\n");

  const heartbeat = setInterval(() => {
    api.agentHeartbeat(machineId).catch(() => {});
  }, 30_000);

  let running = true;
  const stop = () => {
    running = false;
    clearInterval(heartbeat);
  };
  process.on("SIGINT", () => {
    log("\nStopping agent.");
    stop();
    process.exit(0);
  });

  while (running) {
    let claimed: AgentJob | undefined;
    try {
      ({ job: claimed } = await api.claimJob(machineId));
    } catch (err) {
      log(`  (claim error: ${(err as Error).message}; retrying in 5s)`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!claimed) continue; // long-poll timed out; loop again
    log(`Job ${claimed.id}: ${claimed.kind} — ${claimed.instruction.slice(0, 60)}`);
    // Reload config each job so set-workspace/link changes are picked up live.
    await runJob(claimed, await loadAgentConfig());
  }
}
