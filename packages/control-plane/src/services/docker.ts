import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { loadConfig } from "../config.js";
import { shortId } from "../lib/ids.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a docker command, capturing combined output. Never rejects on non-zero. */
function docker(
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      args,
      { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === "number"
            ? ((err as { code?: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Extract a gzipped tar build context to a fresh temp directory. */
export async function extractContext(tarPath: string): Promise<string> {
  const dir = join(tmpdir(), "vibe-build", shortId("ctx"));
  await mkdir(dir, { recursive: true });
  await tar.x({ file: tarPath, cwd: dir });
  return dir;
}

export interface BuildResult {
  ok: boolean;
  imageTag: string;
  log: string;
}

/** Build an image from an extracted context directory. */
export async function buildImage(
  contextDir: string,
  imageTag: string,
  dockerfile: string
): Promise<BuildResult> {
  const res = await docker([
    "build",
    "-t",
    imageTag,
    "-f",
    join(contextDir, dockerfile),
    contextDir,
  ]);
  return {
    ok: res.code === 0,
    imageTag,
    log: `$ docker build -t ${imageTag}\n${res.stdout}\n${res.stderr}`,
  };
}

/** Pull an image from a registry. Never rejects; inspect `.code`. */
export async function pullImage(ref: string): Promise<ExecResult> {
  return docker(["pull", ref]);
}

/**
 * Log the host docker daemon into the configured registry so private app
 * images can be pulled. Best-effort and idempotent: a blank token (public
 * images only) is treated as success. Returns false if login was attempted
 * and failed.
 */
export async function ensureRegistryAuth(): Promise<boolean> {
  const { registry } = loadConfig();
  if (!registry.token || !registry.username) return true;
  const res = await docker(
    [
      "login",
      registry.host,
      "-u",
      registry.username,
      "--password-stdin",
    ],
    { input: registry.token }
  );
  return res.code === 0;
}

export interface RunOptions {
  imageTag: string;
  name: string;
  env: Record<string, string>;
  port: number;
}

/** Start a detached container on the platform network. */
export async function runContainer(opts: RunOptions): Promise<ExecResult> {
  const cfg = loadConfig();
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(opts.env)) {
    envArgs.push("-e", `${k}=${v}`);
  }
  return docker([
    "run",
    "-d",
    "--name",
    opts.name,
    "--network",
    cfg.dockerNetwork,
    "--restart",
    "unless-stopped",
    "--label",
    "vibe.managed=true",
    "-e",
    `PORT=${opts.port}`,
    ...envArgs,
    opts.imageTag,
  ]);
}

/** Run a one-off command in a new container on the platform network (migrations). */
export async function runOneOff(
  imageTag: string,
  env: Record<string, string>,
  port: number,
  command: string
): Promise<ExecResult> {
  const cfg = loadConfig();
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) envArgs.push("-e", `${k}=${v}`);
  return docker([
    "run",
    "--rm",
    "--network",
    cfg.dockerNetwork,
    "-e",
    `PORT=${port}`,
    ...envArgs,
    "--entrypoint",
    "sh",
    imageTag,
    "-c",
    command,
  ]);
}

export async function stopContainer(name: string): Promise<void> {
  await docker(["stop", "-t", "10", name], { timeoutMs: 30_000 });
}

export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], { timeoutMs: 30_000 });
}

/** Remove an image by tag/ref. Best-effort: ignores "in use"/"not found". */
export async function removeImage(ref: string): Promise<void> {
  await docker(["rmi", "-f", ref], { timeoutMs: 60_000 });
}

export async function containerLogs(name: string, tail = 200): Promise<string> {
  const res = await docker(["logs", "--tail", String(tail), name], {
    timeoutMs: 30_000,
  });
  return `${res.stdout}\n${res.stderr}`.trim();
}

/** Whether a container with this name is currently running. */
export async function isRunning(name: string): Promise<boolean> {
  const res = await docker([
    "inspect",
    "-f",
    "{{.State.Running}}",
    name,
  ]);
  return res.code === 0 && res.stdout.trim() === "true";
}

export async function cleanupContext(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
