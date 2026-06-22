import { basename } from "node:path";
import { spawn } from "node:child_process";
import { parseManifest, type Manifest } from "@vibe/shared";
import { api, ApiError } from "./client.js";
import { saveCredentials } from "./config.js";
import { detect } from "./detect.js";
import { hasManifest, loadManifest, saveManifest, slugify } from "./manifest.js";
import { packProject } from "./pack.js";
import { scaffold } from "./scaffold.js";

const cwd = () => process.cwd();

function log(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

/* -------------------------------- init -------------------------------- */

export async function cmdInit(opts: { name?: string }): Promise<void> {
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
  log("\nNext: review vibe.app.yaml, then run `vibe deploy`.");
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
    if (m.runtime.adapter === "custom-dockerfile" && !m.runtime.dockerfile)
      oks.push("custom-dockerfile: expecting ./Dockerfile");
    if (m.capabilities.database && !m.database?.migrations)
      issues.push("database enabled but no migrations command set (database.migrations)");
  } catch (e) {
    issues.push(`manifest invalid: ${(e as Error).message}`);
  }

  for (const o of oks) log(`✓ ${o}`);
  for (const i of issues) log(`⚠ ${i}`);
  log(issues.length ? `\n${issues.length} issue(s) to review.` : "\nAll checks passed.");
}

/* ------------------------------- deploy ------------------------------- */

const TERMINAL = new Set(["live", "failed"]);

export async function cmdDeploy(): Promise<void> {
  const dir = cwd();
  const manifest = await loadManifest(dir);

  log(`Registering ${manifest.name}…`);
  await api.registerApp(manifest);

  log("Packaging build context…");
  const tarGz = await packProject(dir);
  log(`  context: ${(tarGz.length / 1024 / 1024).toFixed(1)} MB`);

  const { deploymentId } = await api.deploy(manifest.id, tarGz);
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
