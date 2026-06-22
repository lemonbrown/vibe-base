import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { parseManifest, type Manifest } from "@vibe/shared";
import { api, ApiError } from "./client.js";
import { hasCredentials, saveCredentials } from "./config.js";
import { detect } from "./detect.js";
import { hasManifest, loadManifest, saveManifest, slugify } from "./manifest.js";
import { packProject } from "./pack.js";
import { scaffold, scaffoldGithub } from "./scaffold.js";

const execFileAsync = promisify(execFile);
const cwd = () => process.cwd();

function log(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

const rel = (dir: string, p: string) =>
  p.replace(dir + "/", "").replace(dir + "\\", "");

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** Derive a GitHub SSH remote from an HTTPS clone URL. */
function toSshUrl(httpsUrl: string): string | undefined {
  const m = httpsUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `git@${m[1]}:${m[2]}.git` : undefined;
}

/** Run a git command in `dir`. Never throws; inspect `.ok`. */
async function git(
  args: string[],
  dir: string
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: dir });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: `${err.stdout ?? ""}${err.stderr ?? err.message ?? ""}`.trim(),
    };
  }
}

/**
 * Ensure the project is a git repo with the scaffold committed. Run by every
 * `vibe init` so an app is always version-controlled from the start — GitHub
 * connection is a separate, later step. Idempotent and best-effort.
 */
async function ensureGitRepo(dir: string): Promise<boolean> {
  if (!(await git(["--version"], dir)).ok) return false; // git not installed

  const inside = (await git(["rev-parse", "--is-inside-work-tree"], dir)).ok;
  if (!inside) {
    if (!(await git(["init"], dir)).ok) return false;
    await git(["branch", "-M", "main"], dir);
  }
  // Make an initial commit only if the repo has no commits yet.
  const hasHead = (await git(["rev-parse", "--verify", "HEAD"], dir)).ok;
  if (!hasHead) {
    await git(["add", "-A"], dir);
    await git(["commit", "-m", "Initial commit (Vibe Base)"], dir);
  }
  return !inside; // true when we created the repo just now
}

/**
 * Register the app, scaffold CI, create a GitHub repo, and push the code so
 * the first deploy runs through Actions. Shared by `init --github` and
 * `github connect`.
 */
async function connectGithub(
  dir: string,
  manifest: Manifest,
  opts: { private?: boolean }
): Promise<void> {
  // Preflight: fail fast with actionable guidance before changing anything.
  if (!(await hasCredentials())) {
    throw new Error(
      "Not logged in to the control plane. Ask the user for their Vibe Base " +
        "control-plane URL and owner token, then run:\n" +
        "  vibe login --url <control-plane-url> --token <owner-token>\n" +
        "Do not fabricate these values."
    );
  }
  if (!(await git(["--version"], dir)).ok) {
    throw new Error("git was not found on PATH — it is required to push to GitHub.");
  }

  log("Registering app with the control plane…");
  await api.registerApp(manifest);

  const { created } = await scaffoldGithub(dir, manifest);
  if (created.length) {
    log("Scaffolded CI:");
    for (const c of created) log(`  + ${rel(dir, c)}`);
  }

  log("Creating GitHub repo…");
  const gh = await api.createRepo(manifest.id, {
    name: manifest.id,
    private: opts.private,
  });
  log(`  ${gh.htmlUrl}`);

  // Local git: init if needed, commit, then push — preferring SSH with an
  // HTTPS fallback, since most setups have only one of the two authenticated.
  const branch = gh.defaultBranch || "main";
  if (!(await git(["rev-parse", "--is-inside-work-tree"], dir)).ok) {
    await git(["init"], dir);
  }
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "Initial commit (Vibe Base)"], dir);
  await git(["branch", "-M", branch], dir);

  const candidates: Array<{ name: string; url: string }> = [];
  const sshUrl = gh.sshUrl ?? toSshUrl(gh.cloneUrl);
  if (sshUrl) candidates.push({ name: "SSH", url: sshUrl });
  candidates.push({ name: "HTTPS", url: gh.cloneUrl });

  let pushed = false;
  let lastOut = "";
  for (const c of candidates) {
    const hasOrigin = (await git(["remote", "get-url", "origin"], dir)).ok;
    await git(
      hasOrigin
        ? ["remote", "set-url", "origin", c.url]
        : ["remote", "add", "origin", c.url],
      dir
    );
    log(`Pushing to ${gh.repo} over ${c.name}…`);
    const push = await git(["push", "-u", "origin", branch], dir);
    if (push.ok) {
      pushed = true;
      break;
    }
    lastOut = push.out;
    log(`  ${c.name} push failed.`);
  }

  if (pushed) {
    log("\n✓ Connected. Pushing to main now builds + deploys via GitHub Actions.");
  } else {
    log("\n⚠ Repo created and remote configured, but the push failed:");
    log(lastOut.split("\n").slice(-6).join("\n"));
    log(`\nFinish manually once your git auth is set up:\n  git push -u origin ${branch}`);
  }
}

/* -------------------------------- init -------------------------------- */

export async function cmdInit(opts: {
  name?: string;
  github?: boolean;
  private?: boolean;
}): Promise<void> {
  const dir = cwd();
  let manifest: Manifest;

  if (await hasManifest(dir)) {
    manifest = await loadManifest(dir);
    log(`Found existing ${"vibe.app.yaml"} for "${manifest.name}".`);
  } else {
    const name = opts.name ?? basename(dir);
    const det = await detect(dir);
    manifest = parseManifest({
      id: slugify(name),
      name,
      description: "",
      capabilities: { auth: true, database: true, storage: false, email: false },
      runtime: {
        adapter: det.adapter,
        framework: det.framework,
        language: det.language,
        packageManager: det.packageManager === "n/a" ? undefined : det.packageManager,
        port: det.port,
        healthPath: det.healthPath,
        buildCommand: det.buildCommand,
        startCommand: det.startCommand,
      },
      database: { engine: "postgres" },
      domain: { subdomain: slugify(name) },
    });
    await saveManifest(dir, manifest);
    log(`Created vibe.app.yaml for "${name}" (adapter: ${det.adapter}).`);
    for (const n of det.notes) log(`  • ${n}`);
  }

  const { created } = await scaffold(dir, manifest);
  if (created.length) {
    log("\nScaffolded:");
    for (const c of created) log(`  + ${c.replace(dir + "/", "").replace(dir + "\\", "")}`);
  }

  // Always version-control the app locally — never depend on the agent for this.
  const initedRepo = await ensureGitRepo(dir);
  if (initedRepo) log("\nInitialized a git repository.");

  if (opts.github) {
    log("");
    await connectGithub(dir, manifest, { private: opts.private });
  } else {
    log(
      "\nNext: review vibe.app.yaml, then run `vibe init --github` to create a" +
        "\nGitHub repo and deploy via GitHub (or `vibe deploy` to build on the VPS)."
    );
  }
}

/* ---------------------------- github connect -------------------------- */

export async function cmdGithubConnect(opts: {
  private?: boolean;
}): Promise<void> {
  const dir = cwd();
  const manifest = await loadManifest(dir);
  await connectGithub(dir, manifest, { private: opts.private });
}

/* ------------------------------- detect ------------------------------- */

export async function cmdDetect(): Promise<void> {
  const det = await detect(cwd());
  log(JSON.stringify(det, null, 2));
}

/* ------------------------------- doctor ------------------------------- */

export async function cmdDoctor(): Promise<void> {
  const issues: string[] = [];
  const oks: string[] = [];
  if (!(await hasManifest(cwd()))) {
    log("✗ no vibe.app.yaml — run `vibe init`");
    return;
  }
  try {
    const m = await loadManifest(cwd());
    oks.push(`manifest valid (${m.id})`);
    if (!m.runtime.healthPath) issues.push("runtime.healthPath is empty");
    if (m.capabilities.database && !m.database?.migrations)
      issues.push("database enabled but no migrations command set (database.migrations)");

    // Build path: a custom-dockerfile app must actually ship a Dockerfile, or
    // the deploy fails with "Dockerfile not found".
    if (m.runtime.adapter === "custom-dockerfile") {
      const df = m.runtime.dockerfile ?? "Dockerfile";
      if (await fileExists(join(cwd(), df))) oks.push(`Dockerfile present (${df})`);
      else
        issues.push(
          `adapter is custom-dockerfile but '${df}' is missing — the deploy will fail without it`
        );
    }

    const pkg = await readPackageJson(cwd());
    const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};

    // A Node app the platform builds needs a way to start.
    if (
      m.runtime.adapter.startsWith("node-") &&
      m.runtime.adapter !== "static-site" &&
      !m.runtime.startCommand &&
      !pkg?.scripts?.start
    ) {
      issues.push(
        "no start command — set runtime.startCommand or add a \"start\" script, or the container won't know how to launch"
      );
    }

    // Email capability vs installed packages: catch the trap where an email
    // library is present but capabilities.email is off, so the platform never
    // injects EMAIL_PROVIDER / the provider credentials.
    const emailPkgs = ["resend", "nodemailer", "googleapis", "@sendgrid/mail"].filter(
      (d) => d in deps
    );
    if (emailPkgs.length && !m.capabilities.email)
      issues.push(
        `email package(s) installed (${emailPkgs.join(", ")}) but capabilities.email is false — ` +
          "set it true so the platform injects EMAIL_* / provider credentials"
      );
  } catch (e) {
    issues.push(`manifest invalid: ${(e as Error).message}`);
  }

  // Auth + tooling preflight — what `vibe init --github` / `deploy` need.
  if (await hasCredentials()) oks.push("logged in to a control plane");
  else
    issues.push(
      "not logged in — run `vibe login --url <url> --token <token>` (ask the user for these)"
    );
  if ((await git(["--version"], cwd())).ok) oks.push("git available");
  else issues.push("git not found on PATH (needed to push to GitHub)");

  for (const o of oks) log(`✓ ${o}`);
  for (const i of issues) log(`⚠ ${i}`);
  log(issues.length ? `\n${issues.length} issue(s) to review.` : "\nAll checks passed.");
}

/* ------------------------------- deploy ------------------------------- */

const TERMINAL = new Set(["live", "failed"]);

export async function cmdDeploy(opts: { image?: string } = {}): Promise<void> {
  const dir = cwd();
  const manifest = await loadManifest(dir);

  log(`Registering ${manifest.name}…`);
  await api.registerApp(manifest);

  let deploymentId: string;
  if (opts.image) {
    log(`Deploying prebuilt image ${opts.image}…`);
    ({ deploymentId } = await api.deployImage(manifest.id, { image: opts.image }));
  } else {
    log("Packaging build context…");
    const tarGz = await packProject(dir);
    log(`  context: ${(tarGz.length / 1024 / 1024).toFixed(1)} MB`);
    ({ deploymentId } = await api.deploy(manifest.id, tarGz));
  }
  log(`Deploying (${deploymentId})…`);

  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { deployment, buildLog } = await api.getDeployment(deploymentId);
    if (deployment.status !== last) {
      log(`  → ${deployment.status}`);
      last = deployment.status;
    }
    if (TERMINAL.has(deployment.status)) {
      if (deployment.status === "failed") {
        log(`\n✗ Deploy failed: ${deployment.error ?? "unknown"}`);
        log("\n--- build log (tail) ---");
        log(buildLog.split("\n").slice(-25).join("\n"));
        process.exitCode = 1;
        return;
      }
      break;
    }
  }

  const { status } = await api.getStatus(manifest.id);
  log(`\n✓ Built and deployed.\n\nURL:\n${status.app.url}\n`);
}

/* ------------------------------- status ------------------------------- */

export async function cmdStatus(json: boolean): Promise<void> {
  const m = await loadManifest(cwd());
  const { status } = await api.getStatus(m.id);
  if (json) return log(JSON.stringify(status, null, 2));
  log(`App: ${status.app.name} (${status.app.id})`);
  log(`Status: ${status.app.status}    Health: ${status.app.health}`);
  log(`URL: ${status.app.url ?? "(not deployed)"}`);
  log(`Runtime: ${status.manifestSummary.runtimeAdapter} :${status.manifestSummary.port}`);
  log(
    `Database: ${status.database.enabled ? (status.database.provisioned ? "provisioned" : "enabled, not provisioned") : "off"}`
  );
  log(
    `Storage: ${status.storage.enabled ? (status.storage.provisioned ? "provisioned" : "enabled, not provisioned") : "off"}`
  );
  log(`Members: ${status.members}`);
  if (status.recentDeployments.length) {
    log("\nRecent deployments:");
    for (const d of status.recentDeployments)
      log(`  ${d.createdAt}  ${d.status}  ${d.id}`);
  }
}

/* -------------------------------- logs -------------------------------- */

export async function cmdLogs(build: boolean): Promise<void> {
  const m = await loadManifest(cwd());
  const { log: out } = await api.logs(m.id, build);
  log(out || "(no logs)");
}

/* ------------------------------- context ------------------------------ */

export async function cmdContext(json: boolean): Promise<void> {
  const m = await loadManifest(cwd());
  let live: Awaited<ReturnType<typeof api.getStatus>>["status"] | null = null;
  try {
    live = (await api.getStatus(m.id)).status;
  } catch {
    // not yet registered — context still useful from the manifest alone
  }

  const caps = Object.entries(m.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (json) {
    return log(
      JSON.stringify(
        { manifest: m, live, rules: RULES }, null, 2
      )
    );
  }

  log(`App: ${m.name}\n`);
  log(`Purpose:\n${m.description || "(none set)"}\n`);
  log(`Visibility: ${m.visibility} · Access: ${m.access.mode}`);
  log(`Runtime: ${m.runtime.adapter} (port ${m.runtime.port}, health ${m.runtime.healthPath})`);
  log(`Capabilities: ${caps.join(", ") || "none"}`);
  if (live) {
    log(`\nLive: ${live.app.status} (${live.app.health}) ${live.app.url ?? ""}`);
  }
  log("\nRules:");
  for (const r of RULES) log(`- ${r}`);
}

const RULES = [
  "Use Vibe Base platform auth — do not implement custom login.",
  "Read the signed-in user from X-Vibe-User-Email / X-Vibe-User-Role headers.",
  "Read config from env vars (DATABASE_URL, S3_*). Never hardcode secrets.",
  "Do not edit proxy/Caddy config; use the vibe CLI for infrastructure.",
  "Update .vibe-memory after meaningful changes.",
];

/* ------------------------------- invite ------------------------------- */

export async function cmdInvite(email: string, role: string): Promise<void> {
  const m = await loadManifest(cwd());
  const res = await api.invite(m.id, email, role);
  log(`Invited ${res.email} as ${res.role}.`);
  log(`\nShare this claim link:\n${res.claimUrl}`);
}

/* -------------------------------- apps -------------------------------- */

export async function cmdApps(): Promise<void> {
  const { apps } = await api.listApps();
  if (!apps.length) return log("No apps yet.");
  for (const a of apps) {
    log(
      `${a.name.padEnd(24)} ${a.status.padEnd(12)} ${a.health.padEnd(10)} ${a.url ?? ""}`
    );
  }
}

/* -------------------------------- open -------------------------------- */

export async function cmdOpen(): Promise<void> {
  const m = await loadManifest(cwd());
  const { status } = await api.getStatus(m.id);
  if (!status.app.url) return log("App is not deployed yet.");
  const url = status.app.url;
  const cmd =
    process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  log(`Opening ${url}`);
}

/* ------------------------------ rollback ------------------------------ */

export async function cmdRollback(): Promise<void> {
  const m = await loadManifest(cwd());
  const res = await api.rollback(m.id);
  log(`Rolled back to ${res.rolledBackTo}`);
}

/* -------------------------------- login ------------------------------- */

export async function cmdLogin(url: string, token: string): Promise<void> {
  await saveCredentials({ apiUrl: url.replace(/\/$/, ""), token });
  log(`Saved credentials for ${url}.`);
}

export function handleError(err: unknown): void {
  if (err instanceof ApiError) {
    log(`Error (${err.status}): ${err.message}`);
  } else {
    log(`Error: ${(err as Error).message}`);
  }
  process.exitCode = 1;
}
