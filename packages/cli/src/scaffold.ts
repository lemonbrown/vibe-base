import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateDockerfile, type Manifest } from "@vibe/shared";

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

**You are expected to operate the platform on the user's behalf.** When a task
needs a \`vibe\` / \`git\` command, run it yourself in your shell — don't hand the
user a list of commands to run. The only exception is credentials you cannot
supply (control-plane login, git auth), where you pause and ask the user.

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
- Use \`DATABASE_URL\` for Postgres and the \`S3_*\` vars for storage — only when
  that capability is enabled. Never wire up your own provider for these.
- For email (when \`capabilities.email\` is on), branch on \`EMAIL_PROVIDER\` and
  send as \`EMAIL_FROM\`; do not configure your own email service:
  - \`gmail-api\`: use the \`googleapis\` package with \`GMAIL_CLIENT_ID\`,
    \`GMAIL_CLIENT_SECRET\`, \`GMAIL_REFRESH_TOKEN\` (OAuth2) to call the Gmail API
    over HTTPS. Prefer this — it works even where outbound SMTP is blocked.
  - \`smtp\`: use \`nodemailer\` with \`SMTP_HOST/PORT/USER/PASS/SECURE\`.
- Expose a health endpoint at the path in \`vibe.app.yaml\` (runtime.healthPath).
- Keep \`.vibe-memory/\` up to date after meaningful changes.
- A \`.gitignore\` is scaffolded for you. **Never commit \`.env\` or secrets**, and
  keep \`node_modules/\` out of git; if it's missing, create one before committing.

Deploying (GitHub is the default path):
- **Credentials:** if any \`vibe\` command reports you are not logged in, stop and
  ask the user for their control-plane URL and owner token, then run
  \`vibe login --url <url> --token <token>\`. Never invent credentials. Pushing to
  GitHub also needs the user's local git auth (e.g. \`gh auth login\`). Run
  \`vibe doctor\` to check both before deploying.
- **You (the agent) run these commands yourself** — do not print the steps and
  ask the user to run them. The point of Vibe Base is that you deploy the app,
  not the user. The only thing you escalate is missing credentials (above).
- If this app isn't connected to GitHub yet, run \`vibe init --github\` (new
  project) or \`vibe github connect\` (existing one), then commit and push — do
  this end to end without pausing:
    vibe github connect            # skip if a git remote already exists
    git add -A && git commit -m "<message>"
    git push origin main
- After that, **deploy by committing and pushing to \`main\`.** GitHub Actions
  builds the image and the platform rolls it out — do not run \`vibe deploy\` for
  normal changes.
- The repo's \`Dockerfile\` defines the build; keep it working. (\`custom-dockerfile\`
  apps own theirs; others get one generated from \`vibe.app.yaml\`.)
- Check progress with \`vibe status\` / \`vibe logs\`; the repo's Deployments tab
  also shows rollout state.
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
${m.capabilities.email ? "- `EMAIL_PROVIDER` (`gmail-api` or `smtp`) + `EMAIL_FROM`. For `gmail-api`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (send via the `googleapis` Gmail API over HTTPS). For `smtp`: `SMTP_HOST/PORT/USER/PASS/SECURE` (nodemailer)." : ""}
- \`X-Vibe-User-Email\` / \`X-Vibe-User-Role\` request headers (gateway auth).
`;
}

const RUNBOOK_MD = `# Runbook

## Deploy
This app deploys through GitHub Actions. Push to \`main\` to ship:
\`git push\` → CI builds + pushes an image to GHCR → the platform pulls it, runs
migrations, health-checks, then flips the proxy to the new version. Rollout
state shows up in the repo's Deployments tab.

First-time setup: \`vibe init --github\` (new project) or \`vibe github connect\`
(existing one) creates the repo and wires up CI.

Manual / no-GitHub fallbacks:
- \`vibe deploy\` — build the context on the VPS instead of via CI.
- \`vibe deploy --image <ref>\` — deploy a specific prebuilt image.

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
    [join(cwd, ".gitignore"), GITIGNORE],
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

const DEPLOY_WORKFLOW = `name: Deploy to Vibe Base

# Build the image in CI, push it to GHCR, then tell the control plane to pull
# and roll it out. Secrets/variables are provisioned by \`vibe github connect\`.
on:
  push:
    branches: [main]
  workflow_dispatch: {}

permissions:
  contents: read
  packages: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Compute image name (lowercase)
        id: img
        run: echo "image=ghcr.io/$(echo '\${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.img.outputs.image }}:\${{ github.sha }}

      - name: Trigger Vibe Base deploy
        env:
          VIBE_API_URL: \${{ vars.VIBE_API_URL }}
          VIBE_APP_ID: \${{ vars.VIBE_APP_ID }}
          VIBE_DEPLOY_TOKEN: \${{ secrets.VIBE_DEPLOY_TOKEN }}
          IMAGE: \${{ steps.img.outputs.image }}:\${{ github.sha }}
        run: |
          curl -fsS -X POST "$VIBE_API_URL/api/apps/$VIBE_APP_ID/deploy/image" \\
            -H "authorization: Bearer $VIBE_DEPLOY_TOKEN" \\
            -H "content-type: application/json" \\
            -d "{\\"image\\":\\"$IMAGE\\",\\"sha\\":\\"\${{ github.sha }}\\",\\"ref\\":\\"\${{ github.ref }}\\"}"
`;

/**
 * Files needed for the GitHub-driven deploy flow: the Actions workflow and a
 * Dockerfile (CI builds the image, so the repo must contain one). Both are
 * written only if missing. Custom-dockerfile apps already ship their own.
 */
export async function scaffoldGithub(
  cwd: string,
  m: Manifest
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const wfDir = join(cwd, ".github", "workflows");
  await mkdir(wfDir, { recursive: true });

  if (await writeIfMissing(join(wfDir, "deploy.yml"), DEPLOY_WORKFLOW)) {
    created.push(join(wfDir, "deploy.yml"));
  }
  // Critical before `git add -A`: keep node_modules and .env out of the repo.
  if (await writeIfMissing(join(cwd, ".gitignore"), GITIGNORE)) {
    created.push(join(cwd, ".gitignore"));
  }
  if (m.runtime.adapter !== "custom-dockerfile") {
    if (await writeIfMissing(join(cwd, "Dockerfile"), generateDockerfile(m))) {
      created.push(join(cwd, "Dockerfile"));
    }
  }
  return { created };
}

function envExample(m: Manifest): string {
  const lines = ["# Platform-provided (do not set manually):", "# PORT", "# VIBE_APP_ID"];
  if (m.capabilities.database) lines.push("# DATABASE_URL");
  if (m.capabilities.storage)
    lines.push("# S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  if (m.capabilities.email)
    lines.push(
      "# EMAIL_PROVIDER, EMAIL_FROM (+ GMAIL_* for gmail-api, or SMTP_* for smtp)"
    );
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

const GITIGNORE = `# Dependencies / build output
node_modules/
dist/
.next/
build/
*.log

# Secrets — never commit these
.env
.env.local
.env.*.local

# Vibe Base local state (keep .vibe-memory/ — it is meant to be committed)
.vibe/state.json

# OS / editor
.DS_Store
`;
