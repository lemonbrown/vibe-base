import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
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
 * Pick the most informative single line from raw tool output for display.
 * Prefers Docker "Step N/M" lines; skips registry noise and short lines.
 * Returns "" when there's nothing worth showing.
 */
export function extractProgressLine(output: string): string {
  if (!output || output.length < 10) return "";
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  // Docker step headers are the most useful progress signal
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (/^Step \d+\/\d+\b/.test(l)) return l.slice(0, 140);
  }

  // Skip registry pull noise, sha256 digests, and very short tokens
  const noise =
    /^(#\d+\b|sha256:|---> |Successfully built|Successfully tagged|Removing intermediate|CACHED\b|digest:|status:|Pulling from|Waiting|Verifying Checksum|Downloading|Extracting|Pull complete)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!noise.test(l) && l.length > 4) return l.slice(0, 140);
  }

  return lines[lines.length - 1]!.slice(0, 140);
}

/**
 * Extract a short human-readable label from a Codex command_execution command string.
 * Strips the PowerShell/sh wrapper so the portal shows the actual command, not the shell path.
 */
export function codexCommandDisplay(cmd: string): string {
  // PowerShell wrapper: "...powershell.exe" -Command 'actual command'
  const psMatch = cmd.match(/-Command\s+'([^']+)'/i);
  if (psMatch?.[1]) return psMatch[1].slice(0, 60);
  // sh/bash wrapper: /bin/sh -c 'actual command'
  const shMatch = cmd.match(/-c\s+'([^']+)'/);
  if (shMatch?.[1]) return shMatch[1].slice(0, 60);
  // Fallback: strip leading path component and truncate
  return cmd.replace(/^"?[^"]*[/\\]([^/\\"]+)"?\s*/, "$1 ").trim().slice(0, 60);
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
      const block = raw as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown };
      if (block.type === "text" && block.text) {
        events.push({ seq: 0, type: "text", data: { text: block.text } });
      } else if (block.type === "thinking" && block.thinking) {
        events.push({ seq: 0, type: "thinking", data: { text: block.thinking } });
      } else if (block.type === "tool_use") {
        events.push({ seq: 0, type: "tool", data: { name: block.name, input: block.input } });
      }
    }
  } else if (type === "user" && obj.message) {
    // Tool results arrive as user messages with tool_result content blocks.
    // Extract a progress line so the portal can show what each tool produced.
    const content = (obj.message as { content?: unknown[] }).content ?? [];
    for (const raw of content) {
      const block = raw as { type?: string; content?: unknown };
      if (block.type !== "tool_result") continue;
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = (block.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text ?? "")
          .join("\n");
      }
      const output = extractProgressLine(text);
      if (output) {
        events.push({ seq: 0, type: "status", data: { phase: "tool_result", output } });
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
  cancelled?: boolean;
}

type Enqueue = (events: JobEvent[]) => void;

/**
 * Polls the control plane every 2s to detect if the user cancelled the job.
 * When detected, sends SIGTERM to the child process (SIGKILL after 3s).
 * Returns a disposer that clears the interval.
 */
function watchForCancellation(
  jobId: string,
  kill: () => void
): () => void {
  let triggered = false;
  const iv = setInterval(() => {
    api.checkJobCancelled(jobId).then(({ cancelling }) => {
      if (cancelling && !triggered) {
        triggered = true;
        kill();
      }
    }).catch(() => {});
  }, 2000);
  return () => clearInterval(iv);
}

function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams {
  if (process.platform !== "win32") {
    return spawn(command, args, { ...options, shell: false });
  }

  // npm-installed CLIs on Windows are commonly .cmd shims. Node cannot execute
  // those directly with shell: false, so let cmd.exe resolve the command while
  // keeping the argument list separate.
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
    ...options,
    shell: false,
  });
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
  "to list them). Do NOT modify any files or deploy. " +
  "Tool outputs are NOT visible to the user — always write a concise text answer " +
  "based on what the tools returned.";

function buildPreamble(appId: string): string {
  return (
    `You are building a NEW Vibe Base app with id "${appId}" in this empty directory. ` +
    `First run \`vibe init --name ${appId}\` to scaffold it, then read AGENTS.md and build ` +
    `the app per the request. Declare \`readModels\` in vibe.app.yaml for any data the user ` +
    `might ask about.\n\n` +
    `Add an \`icon\` field to vibe.app.yaml containing a self-contained SVG that visually ` +
    `represents the app's purpose. Use a square viewBox (e.g. viewBox="0 0 64 64"), flat or ` +
    `subtly-gradated colors, and no scripts or external references. The icon appears in the ` +
    `owner portal's app grid, so make it recognizable at 40×40 px.\n\n` +
    `Before running \`vibe ship\`, write end-to-end acceptance tests that cover the primary ` +
    `user flows described in the request. Place them in tests/smoke.spec.ts using ` +
    `Playwright's \`@playwright/test\` runner (add it to devDependencies if absent). ` +
    `Also write playwright.config.ts at the project root — set baseURL from the ` +
    `PLAYWRIGHT_BASE_URL environment variable, falling back to http://localhost:3000, ` +
    `and set testDir to "tests". ` +
    `Once the app builds, run \`vibe ship\` to deploy, then immediately run \`vibe ci\` ` +
    `to monitor the GitHub Actions build. If CI fails, read the log output it prints, fix ` +
    `the issue, and run \`vibe ship\` again. Use the \`vibe\` CLI for all infrastructure ` +
    `and keep .vibe-memory/ up to date.\n\n` +
    `If the app needs to generate text or content with an LLM, set \`capabilities.llm: true\` ` +
    `in vibe.app.yaml and call \`POST $VIBE_CONTROL_URL/api/apps/$VIBE_APP_ID/llm\` from the ` +
    `server (Authorization: Bearer $VIBE_OWNER_TOKEN). Both env vars are injected automatically ` +
    `at deploy time. See the LLM generation section of AGENTS.md for the full SSE streaming example.`
  );
}

const ADJUST_PREAMBLE =
  "You are updating an existing Vibe Base app. Follow AGENTS.md in this directory. " +
  "Use the `vibe` CLI for infrastructure and run `vibe ship` to deploy when ready, " +
  "then run `vibe ci` to monitor the GitHub Actions build. If CI fails, read the log " +
  "output, fix the issue, and run `vibe ship` again. " +
  "Keep readModels in vibe.app.yaml current and .vibe-memory/ up to date.\n\n" +
  "If the app needs to generate text or content with an LLM, set `capabilities.llm: true` " +
  "in vibe.app.yaml and call `POST $VIBE_CONTROL_URL/api/apps/$VIBE_APP_ID/llm` from the " +
  "server (Authorization: Bearer $VIBE_OWNER_TOKEN). Both env vars are injected automatically " +
  "at deploy time. See the LLM generation section of AGENTS.md for the full SSE streaming example.";

const CHAT_PREAMBLE =
  "You are a Vibe Base assistant with full access to the workspace. " +
  "Run `vibe apps` to list available apps, `vibe platform` for an overview, " +
  "`vibe platform app <id>` for details on one app, and `vibe query <model> --app <id>` to read data. " +
  "Determine from the user's message whether to answer a question, build a new app (`vibe init`), " +
  "or modify an existing one. For code changes, make edits, run `vibe ship` to deploy, then `vibe ci` " +
  "to monitor the GitHub Actions build (fix and re-ship if it fails). " +
  "Follow AGENTS.md if present and keep .vibe-memory/ up to date in any app you touch.\n\n" +
  "IMPORTANT: Tool outputs and thinking are NOT visible to the user — only your text responses are. " +
  "You MUST always end with a clear text response that directly answers the user's question or " +
  "summarises what you did. Never complete a turn silently after tool use.\n\n" +
  "When building a NEW app: " +
  "(1) Add an `icon` field to vibe.app.yaml with a self-contained SVG that visually represents the app. " +
  "Use a square viewBox (e.g. viewBox=\"0 0 64 64\"), flat or subtly-gradated colors, no scripts or external refs. " +
  "The icon appears in the portal app grid — make it recognizable at 40×40 px. " +
  "(2) Before deploying, write end-to-end acceptance tests in tests/smoke.spec.ts using `@playwright/test` " +
  "(add it to devDependencies if absent) and a playwright.config.ts at the project root that reads baseURL " +
  "from PLAYWRIGHT_BASE_URL (fallback http://localhost:3000) and sets testDir to \"tests\".";

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

  if (kind === "generate") {
    await mkdir(cfg.workspaceRoot, { recursive: true });
    return {
      cwd: cfg.workspaceRoot,
      allowedTools: [],
      permissionMode: "default",
      preamble: "",
    };
  }

  if (kind === "chat") {
    await mkdir(cfg.workspaceRoot, { recursive: true });
    return {
      cwd: cfg.workspaceRoot,
      allowedTools: WRITE_TOOLS,
      permissionMode: "acceptEdits",
      preamble: CHAT_PREAMBLE,
    };
  }

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
  // Generate jobs send the raw instruction as the prompt — no preamble or portal UI wrappers.
  if (job.kind === "generate") return job.instruction;

  const planMode = job.planMode
    ? "This job is in plan mode. Your role is a collaborative thought partner, not a technical planner. " +
      "Focus entirely on what the user wants to build and why — features, goals, and user experience — not on implementation details, file structure, or technology choices. " +
      "Engage in open discussion: ask clarifying questions, make suggestions, surface trade-offs, and push back thoughtfully if a direction seems unclear or misguided. " +
      "Help the user think through what they actually want before anything gets built. " +
      "Do not propose code, architecture, or implementation steps. Do not edit files, run deploys, or execute mutating commands. " +
      "When the feature scope feels clear and agreed upon, include a `vibe-ui` Go action with `planMode: false` so the user can kick off the build."
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
  // Pipe the prompt via stdin (-p with no value = print/non-interactive mode,
  // prompt is read from stdin). This avoids Windows cmd.exe argument-escaping
  // issues with long prompts containing quotes, backticks, and newlines.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    job.planMode ? "plan" : plan.permissionMode,
  ];
  if (plan.allowedTools.length > 0) {
    args.push("--allowedTools", plan.allowedTools.join(","));
  }
  if (job.llmModel.trim()) args.push("--model", job.llmModel.trim());
  if (job.stackPolicy && job.stackPolicy.trim()) args.push("--append-system-prompt", job.stackPolicy);
  if (job.llmSessionId) args.push("--resume", job.llmSessionId);

  log(`  claude args: ${args.join(" ")}`);

  let sessionId: string | undefined = job.llmSessionId ?? undefined;
  let finalText = "";
  let failed = false;
  let cancelled = false;
  let stdoutLines = 0;

  await new Promise<void>((resolveRun) => {
    const child = spawnCli("claude", args, { cwd: plan.cwd });
    child.stdin.end(prompt, "utf8");

    const stopWatcher = watchForCancellation(job.id, () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 3000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (stdoutLines < 5) log(`  stdout[${stdoutLines}]: ${line.slice(0, 120)}`);
      stdoutLines++;
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
      stopWatcher();
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
      stopWatcher();
      log(`  claude exited: code=${code} stdout_lines=${stdoutLines} stderr=${JSON.stringify(stderr.trim().slice(0, 200))}`);
      if (cancelled) {
        resolveRun();
        return;
      }
      if (code !== 0 && !finalText) {
        finalText = stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`;
        failed = true;
      }
      resolveRun();
    });
  });

  return { sessionId, finalText, failed, cancelled };
}

function extractCodexSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["thread_id", "session_id", "sessionId", "conversation_id", "conversationId"]) {
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
  if (job.llmReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(job.llmReasoningEffort)}`);
  }
  if (job.kind !== "ask" && job.kind !== "generate" && !job.planMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (!job.llmSessionId) {
    args.push("--sandbox", "read-only");
  }
  if (job.llmSessionId) args.push(job.llmSessionId);
  args.push("-");

  let sessionId: string | undefined = job.llmSessionId ?? undefined;
  let failed = false;
  let cancelled = false;
  let stderr = "";

  try {
    await new Promise<void>((resolveRun) => {
      const child = spawnCli("codex", args, { cwd: plan.cwd });
      child.stdin.end(prompt);

      const stopWatcher = watchForCancellation(job.id, () => {
        cancelled = true;
        child.kill("SIGTERM");
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 3000);
      });

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          sessionId = extractCodexSessionId(obj) ?? sessionId;
          const type = typeof obj.type === "string" ? obj.type : "";
          if (!type) return;

          const item = obj.item as Record<string, unknown> | undefined;
          const itemType = item && typeof item.type === "string" ? item.type : "";

          if (type === "item.started" && itemType === "command_execution") {
            // Show a tool chip as soon as the command begins running.
            const cmd = typeof item!.command === "string" ? item!.command : "";
            enqueue([{ seq: 0, type: "tool", data: { name: codexCommandDisplay(cmd) } }]);
          } else if (type === "item.completed") {
            if (itemType === "agent_message" && typeof item!.text === "string" && item!.text) {
              enqueue([{ seq: 0, type: "text", data: { text: item!.text } }]);
            } else if (itemType === "command_execution") {
              const output = typeof item!.aggregated_output === "string" ? item!.aggregated_output : "";
              const progress = extractProgressLine(output);
              if (progress) enqueue([{ seq: 0, type: "status", data: { phase: "tool_result", output: progress } }]);
            }
          }
          // thread.started, turn.started/completed, and other lifecycle events are noise — suppress.
        } catch {
          /* Ignore non-JSON defensive noise. */
        }
      });
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("error", (err) => {
        stopWatcher();
        stderr +=
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "`codex` CLI not found on PATH - install it and log in before selecting Codex."
            : err.message;
        failed = true;
        resolveRun();
      });
      child.on("close", (code) => {
        stopWatcher();
        if (code !== 0 && !cancelled) failed = true;
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
    return { sessionId, finalText, failed, cancelled };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/* ----------------------------- verify jobs -------------------------------- */

interface VerifyInstruction {
  appUrl: string;
  ownerEmail: string;
}

async function runPlaywrightTests(
  appDir: string,
  appUrl: string
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(
      "npx",
      ["playwright", "test", "--reporter=list"],
      { cwd: appDir, env: { ...process.env, PLAYWRIGHT_BASE_URL: appUrl, CI: "1" } }
    );
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => resolve({ passed: code === 0, output: output.slice(-8000) }));
    child.on("error", (err) =>
      resolve({ passed: false, output: output || (err as Error).message })
    );
  });
}

async function captureScreenshot(url: string, viewportSize: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawnCli(
      "npx",
      [
        "playwright",
        "screenshot",
        "--browser", "chromium",
        "--viewport-size", viewportSize,
        "--full-page",
        url,
        outPath,
      ],
      { cwd: join(outPath, "..") }
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // best-effort; don't block on missing Playwright
  });
}

async function runVerifyJob(job: AgentJob, cfg: AgentConfig): Promise<void> {
  let parsed: VerifyInstruction;
  try {
    parsed = JSON.parse(job.instruction) as VerifyInstruction;
  } catch {
    await api.completeJob(job.id, { status: "failed", error: "invalid verify instruction JSON" });
    return;
  }

  const { appUrl } = parsed;
  const { path: appDir } = resolveAppPath(cfg, job.targetApp!);
  const verifyDir = join(appDir, ".vibe-verify");
  await mkdir(verifyDir, { recursive: true });

  log(`  -> verify ${job.targetApp} at ${appUrl}`);

  const testResult = await runPlaywrightTests(appDir, appUrl);
  log(testResult.passed ? "  ok tests passed" : "  x tests failed");

  const viewports: Array<{ name: string; size: string }> = [
    { name: "mobile", size: "375, 667" },
    { name: "tablet", size: "768, 1024" },
    { name: "desktop", size: "1440, 900" },
  ];
  const screenshotPaths: Record<string, string> = {};
  for (const vp of viewports) {
    const outPath = join(verifyDir, `${vp.name}.png`);
    await captureScreenshot(appUrl, vp.size, outPath);
    screenshotPaths[vp.name] = outPath;
    log(`  screenshot ${vp.name} -> ${outPath}`);
  }

  try {
    const result = await api.completeVerifyJob(job.id, {
      passed: testResult.passed,
      testOutput: testResult.output,
      screenshotPaths,
    });
    if (result.adjustJobId) {
      log(`  queued adjust job ${result.adjustJobId} to fix failures`);
    }
  } catch (err) {
    await api.completeJob(job.id, { status: "failed", error: (err as Error).message });
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Run one job with the selected local LLM provider, stream events back to the
 * control plane, and finalize with the provider session id + final answer.
 */
async function runJob(job: AgentJob, cfg: AgentConfig): Promise<void> {
  if (job.kind === "verify") {
    await runVerifyJob(job, cfg);
    return;
  }

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
  const eventCounts: Record<string, number> = {};
  const enqueue = (events: JobEvent[]): void => {
    if (!events.length) return;
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    queue.push(...events);
    if (queue.length >= 2) flushing = flushing.then(flush);
  };

  const ticker = setInterval(() => {
    flushing = flushing.then(flush);
  }, 100);

  log(
    `  -> ${job.llmProvider} ${job.llmModel} (${job.kind}${job.planMode ? ", plan" : ""}) in ${plan.cwd}`
  );

  let result: RunnerResult;
  try {
    result =
      job.llmProvider === "codex"
        ? await runCodex(job, plan, prompt, enqueue)
        : await runClaude(job, plan, prompt, enqueue);

    // Claude CLI returns "[Request interrupted by user]" when asked to resume
    // a session that was previously cut off by SIGTERM/SIGINT. Retry once
    // without --resume so the user's message actually gets answered.
    if (
      job.llmProvider !== "codex" &&
      job.llmSessionId &&
      !result.cancelled &&
      result.finalText.includes("[Request interrupted by user]")
    ) {
      log("  ! interrupted session detected — retrying without --resume");
      const freshJob = { ...job, llmSessionId: null };
      queue = [];
      result = await runClaude(freshJob, plan, prompt, enqueue);
    }
  } catch (err) {
    result = { finalText: (err as Error).message, failed: true };
  } finally {
    clearInterval(ticker);
  }

  await flushing;
  await flush();
  const completionStatus = result.cancelled ? "stopped" : result.failed ? "failed" : "done";
  log(`  events: ${JSON.stringify(eventCounts)}`);
  log(`  finalText (${result.finalText.length} chars): ${JSON.stringify(result.finalText.slice(0, 120))}`);
  await api.completeJob(job.id, {
    status: completionStatus,
    error: result.cancelled ? "Stopped." : result.failed ? result.finalText.slice(0, 2000) : undefined,
    llmProvider: job.llmProvider,
    llmSessionId: result.sessionId,
    finalText: result.cancelled ? undefined : result.finalText,
  });
  log(result.cancelled ? "  - job stopped" : result.failed ? "  x job failed" : "  ok job done");
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
