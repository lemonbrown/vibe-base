import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "@vibe/shared";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Write a file only if it does not already exist (never clobber memory). */
async function writeIfMissing(p: string, content: string): Promise<boolean> {
  if (await exists(p)) return false;
  await writeFile(p, content, "utf8");
  return true;
}

const AGENTS_MD = `# LLM Instructions for this App

This project uses **Vibe Base**. Infrastructure (deploy, database, storage,
auth, domains) is provided by the platform — do not reinvent it.

Before making changes:
1. Read \`vibe.app.yaml\` (the source of truth).
2. Run \`vibe context\` for a compact summary of this app.
3. Run \`vibe status\` to see live state.

Rules:
- Use the \`vibe\` CLI for infrastructure; never edit proxy/Caddy config by hand.
- **Do not build custom auth.** Login is handled by the platform gateway.
  Your app receives the signed-in user via request headers:
  \`X-Vibe-User-Email\` and \`X-Vibe-User-Role\`. Trust them; do not add a login UI.
- Read config from environment variables. Never hardcode secrets.
- Use \`DATABASE_URL\` for Postgres and the \`S3_*\` vars for storage (only if enabled).
- Expose a health endpoint at the path in \`vibe.app.yaml\` (runtime.healthPath).
- Keep \`.vibe-memory/\` up to date after meaningful changes.
- Deploy with \`vibe deploy\`.
`;

function overviewMd(m: Manifest): string {
  return `# Overview

**${m.name}**

${m.description || "_Describe the app's purpose here._"}

- Visibility: ${m.visibility}
- Access: ${m.access.mode} (default role: ${m.access.defaultRole})
- Roles: ${m.roles.join(", ")}

## Users
_Who uses this app and how they get access._

## Notes
_Anything a future LLM session should know before changing this app._
`;
}

function runtimeMd(m: Manifest): string {
  return `# Runtime

- Adapter: ${m.runtime.adapter}
- Framework: ${m.runtime.framework ?? "n/a"}
- Language: ${m.runtime.language ?? "n/a"}
- Package manager: ${m.runtime.packageManager ?? "n/a"}
- Port: ${m.runtime.port} (the platform also injects \`$PORT\`)
- Health endpoint: ${m.runtime.healthPath}
- Build: ${m.runtime.buildCommand ?? "(image default)"}
- Start: ${m.runtime.startCommand ?? "(image default)"}
${m.database?.migrations ? `- Migrations: ${m.database.migrations}` : ""}

## Environment provided by the platform
- \`PORT\` — always injected.
- \`VIBE_APP_ID\`, \`VIBE_APP_NAME\`.
${m.capabilities.database ? "- `DATABASE_URL` — Postgres connection string." : ""}
${m.capabilities.storage ? "- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE`." : ""}
- \`X-Vibe-User-Email\` / \`X-Vibe-User-Role\` request headers (gateway auth).
`;
}

const RUNBOOK_MD = `# Runbook

## Deploy
\`vibe deploy\` — tars the project, builds a container, runs migrations,
health-checks, then flips the proxy to the new version.

## Logs
- \`vibe logs\` — runtime logs of the live container.
- \`vibe logs --build\` — build log of the current deployment.

## Rollback
\`vibe deploy rollback\` — re-point the proxy at the previous container.

## Members
- \`vibe invite <email> --role member\` — returns a claim link to share.
- Login is enforced at the gateway; the app never sees unauthenticated traffic
  (unless access mode is \`open\`).

## Troubleshooting
- Health check failing? Confirm the app listens on \`$PORT\` and serves the
  health path in \`vibe.app.yaml\`.
`;

export interface ScaffoldResult {
  created: string[];
}

export async function scaffold(cwd: string, m: Manifest): Promise<ScaffoldResult> {
  const created: string[] = [];
  const memDir = join(cwd, ".vibe-memory");
  const vibeDir = join(cwd, ".vibe");
  await mkdir(memDir, { recursive: true });
  await mkdir(vibeDir, { recursive: true });

  const writes: Array<[string, string]> = [
    [join(cwd, "AGENTS.md"), AGENTS_MD],
    [join(cwd, ".env.example"), envExample(m)],
    [join(memDir, "overview.md"), overviewMd(m)],
    [join(memDir, "runtime.md"), runtimeMd(m)],
    [join(memDir, "runbook.md"), RUNBOOK_MD],
    [join(cwd, ".dockerignore"), DOCKERIGNORE],
  ];
  for (const [p, content] of writes) {
    if (await writeIfMissing(p, content)) created.push(p);
  }

  // Derived files: always regenerate.
  await writeFile(
    join(vibeDir, "runtime.json"),
    JSON.stringify(m.runtime, null, 2),
    "utf8"
  );
  return { created };
}

function envExample(m: Manifest): string {
  const lines = ["# Platform-provided (do not set manually):", "# PORT", "# VIBE_APP_ID"];
  if (m.capabilities.database) lines.push("# DATABASE_URL");
  if (m.capabilities.storage)
    lines.push("# S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  lines.push("", "# Your app's own variables go below (set with `vibe env set`):");
  return lines.join("\n") + "\n";
}

const DOCKERIGNORE = `node_modules
.git
.next
dist
.env
.env.local
*.log
.vibe/state.json
`;
