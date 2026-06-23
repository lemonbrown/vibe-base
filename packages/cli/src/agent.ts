import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentJob, JobEvent, JobKind } from "@vibe/shared";
import { api } from "./client.js";
import { hasCredentials } from "./config.js";
import { slugify } from "./manifest.js";
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
 * crashes the daemon. `seq` is a placeholder (0) - the control plane assigns the
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

interface RunnerResult {
  sessionId?: string;
  finalText: string;
  failed: boolean;
}

type Enqueue = (events: JobEvent[]) => void;

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

function buildPreamble(appId: string): string {
  return (
    `You are building a NEW Vibe Base app with id "${appId}" in this empty directory. ` +
    `First run \`vibe init --name ${appId}\` to scaffold it, then read AGENTS.md and build ` +
    `the app per the request. Declare \`readModels\` in vibe.app.yaml for any data the user ` +
    `might ask about. When it builds, run \`vibe ship\` to deploy. Use the \`vibe\` CLI for all ` +
    `infrastructure and keep .vibe-memory/ up to date.`
  );
}

const ADJUST_PREAMBLE =
  "You are updating an existing Vibe Base app. Follow AGENTS.md in this directory. " +
  "Use the `vibe` CLI for infrastructure and run `vibe ship` to deploy when ready. " +
  "Keep readModels in vibe.app.yaml current and .vibe-memory/ up to date.";

function portalUiPreamble(job: AgentJob): string {
  const target = job.targetApp ? `"${job.targetApp}"` : "null";
  return [
    "The portal chat renders markdown, including headings, lists, tables, links, and fenced code.",
    "When the next step should be a button or a user choice, include a hidden portal trigger block in your markdown response.",
    "The block must be valid JSON in a fenced code block tagged `vibe-ui`. The portal hides the block and renders its actions.",
    "When the user presses an action, the portal sends that action's `prompt` as the next user message using the provided `kind`, `targetApp`, and `planMode` fields.",
    `Current portal job context: kind=${job.kind}, targetApp=${target}, planMode=${job.planMode}.`,
    "For a finished plan that is ready to run, add a primary Go action with the same kind and targetApp, and set planMode to false.",
    "For alternatives, add a `choices` array whose `options` each have a label and prompt.",
    "Example:",
    "```vibe-ui",
    JSON.stringify(
      {
        actions: [
          {
            label: "Go",
            prompt: "Proceed with the proposed plan.",
            kind: job.kind,
            targetApp: job.targetApp,
            planMode: false,
            variant: "primary",
          },
        ],
        choices: [
          {
            label: "Pick an approach",
            options: [
              {
                label: "Simple",
                prompt: "Use the simple approach.",
                kind: job.kind,
                targetApp: job.targetApp,
                planMode: false,
              },
              {
                label: "More polished",
                prompt: "Use the more polished approach.",
                kind: job.kind,
                targetApp: job.targetApp,
                planMode: false,
              },
            ],
          },
        ],
      },
      null,
      2
    ),
    "```",
  ].join("\n");
}

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

  if (kind === "build") {
    const appId = job.targetApp ? slugify(job.targetApp) : `app-${Date.now().toString(36)}`;
    const { path } = resolveAppPath(cfg, appId);
    await mkdir(path, { recursive: true });
    if (!cfg.apps[appId]) {
      cfg.apps[appId] = path;
      await saveAgentConfig(cfg);
    }
    return {
      cwd: path,
      allowedTools: WRITE_TOOLS,
      permissionMode: "acceptEdits",
      preamble: buildPreamble(appId),
    };
  }

  if (!job.targetApp) {
    throw new Error("adjust job needs a target app - pick one in the chat");
  }
  const { path } = resolveAppPath(cfg, job.targetApp);
  if (!(await exists(path))) {
    throw new Error(
      `app "${job.targetApp}" has no local directory at ${path} - link it with \`vibe agent link ${job.targetApp} <path>\``
    );
  }
  return {
    cwd: path,
    allowedTools: WRITE_TOOLS,
    permissionMode: "acceptEdits",
    preamble: ADJUST_PREAMBLE,
  };
}

function jobPrompt(job: AgentJob, plan: Plan): string {
  const planMode = job.planMode
    ? "This job is in plan mode. Research and propose a concrete plan, but do not edit files, run deploys, or execute mutating commands. If the plan is ready to run, include a `vibe-ui` Go action with `planMode: false`."
    : "";
  const policy =
    job.stackPolicy && job.stackPolicy.trim()
      ? `Owner stack/preferences policy:\n${job.stackPolicy.trim()}`
      : "";
  return [plan.preamble, portalUiPreamble(job), planMode, policy, "---", job.instruction]
    .filter(Boolean)
    .join("\n\n");
}

async function runClaude(
  job: AgentJob,
  plan: Plan,
  prompt: string,
  enqueue: Enqueue
): Promise<RunnerResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    job.planMode ? "plan" : plan.permissionMode,
    "--allowedTools",
    plan.allowedTools.join(","),
  ];
  if (job.llmModel.trim()) args.push("--model", job.llmModel.trim());
  if (job.stackPolicy && job.stackPolicy.trim()) args.push("--append-system-prompt", job.stackPolicy);
  if (job.llmSessionId) args.push("--resume", job.llmSessionId);

  let sessionId: string | undefined = job.llmSessionId ?? undefined;
  let finalText = "";
  let failed = false;

  await new Promise<void>((resolveRun) => {
    const child = spawn("claude", args, { cwd: plan.cwd, shell: false });

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
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "`claude` CLI not found on PATH - install it and log in with your subscription."
          : err.message;
      finalText = finalText || msg;
      failed = true;
      stderr += msg;
      resolveRun();
    });

    child.on("close", (code) => {
      if (code !== 0 && !finalText) {
        finalText = stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`;
        failed = true;
      }
      resolveRun();
    });
  });

  return { sessionId, finalText, failed };
}

function extractCodexSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  if (typeof obj.type === "string" && obj.type.toLowerCase().includes("session")) {
    if (typeof obj.id === "string") return obj.id;
  }
  for (const key of ["session", "conversation", "thread"]) {
    const id = extractCodexSessionId(obj[key]);
    if (id) return id;
  }
  return undefined;
}

async function runCodex(
  job: AgentJob,
  plan: Plan,
  prompt: string,
  enqueue: Enqueue
): Promise<RunnerResult> {
  const temp = await mkdtemp(join(tmpdir(), "vibe-codex-"));
  const outFile = join(temp, "last-message.md");
  const args = job.llmSessionId ? ["exec", "resume"] : ["exec", "-C", plan.cwd];

  args.push("--json", "--skip-git-repo-check", "-o", outFile);
  if (job.llmModel.trim()) args.push("--model", job.llmModel.trim());
  if (job.kind !== "ask" && !job.planMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (!job.llmSessionId) {
    args.push("--sandbox", "read-only");
  }
  if (job.llmSessionId) args.push(job.llmSessionId);
  args.push("-");

  let sessionId: string | undefined = job.llmSessionId ?? undefined;
  let failed = false;
  let stderr = "";

  try {
    await new Promise<void>((resolveRun) => {
      const child = spawn("codex", args, { cwd: plan.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(prompt);

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        try {
          const obj = JSON.parse(line) as unknown;
          sessionId = extractCodexSessionId(obj) ?? sessionId;
          const type =
            typeof obj === "object" && obj && "type" in obj
              ? String((obj as { type?: unknown }).type)
              : "";
          if (type) enqueue([{ seq: 0, type: "status", data: { provider: "codex", event: type } }]);
        } catch {
          /* Ignore non-JSON defensive noise. */
        }
      });
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("error", (err) => {
        stderr +=
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "`codex` CLI not found on PATH - install it and log in before selecting Codex."
            : err.message;
        failed = true;
        resolveRun();
      });
      child.on("close", (code) => {
        if (code !== 0) failed = true;
        resolveRun();
      });
    });

    let finalText = "";
    try {
      finalText = (await readFile(outFile, "utf8")).trim();
    } catch {
      finalText = "";
    }
    if (!finalText && failed) {
      finalText = stderr.trim().split("\n").slice(-8).join("\n") || "codex failed without a final message";
    }
    return { sessionId, finalText, failed };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Run one job with the selected local LLM provider, stream events back to the
 * control plane, and finalize with the provider session id + final answer.
 */
async function runJob(job: AgentJob, cfg: AgentConfig): Promise<void> {
  let plan: Plan;
  try {
    plan = await planJob(job, cfg);
  } catch (err) {
    await api.completeJob(job.id, { status: "failed", error: (err as Error).message });
    log(`  x ${(err as Error).message}`);
    return;
  }

  const prompt = jobPrompt(job, plan);

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

  const ticker = setInterval(() => {
    flushing = flushing.then(flush);
  }, 500);

  log(
    `  -> ${job.llmProvider} ${job.llmModel} (${job.kind}${job.planMode ? ", plan" : ""}) in ${plan.cwd}`
  );

  let result: RunnerResult;
  try {
    result =
      job.llmProvider === "codex"
        ? await runCodex(job, plan, prompt, enqueue)
        : await runClaude(job, plan, prompt, enqueue);
  } catch (err) {
    result = { finalText: (err as Error).message, failed: true };
  } finally {
    clearInterval(ticker);
  }

  await flushing;
  await flush();
  await api.completeJob(job.id, {
    status: result.failed ? "failed" : "done",
    error: result.failed ? result.finalText.slice(0, 2000) : undefined,
    llmProvider: job.llmProvider,
    llmSessionId: result.sessionId,
    finalText: result.finalText,
  });
  log(result.failed ? "  x job failed" : "  ok job done");
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
  log("Waiting for jobs... (Ctrl-C to stop)\n");

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
    if (!claimed) continue;
    log(
      `Job ${claimed.id}: ${claimed.llmProvider}/${claimed.llmModel} ${claimed.kind} - ${claimed.instruction.slice(0, 60)}`
    );
    await runJob(claimed, await loadAgentConfig());
  }
}
