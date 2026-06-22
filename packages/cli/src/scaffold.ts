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

\`vibe init\` already made this a git repository. Commit your work as you go.

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
- For email (when \`capabilities.email\` is on), **use the scaffolded helper**
  \`lib/email.js\` — \`const { sendEmail } = require('./lib/email');\` then
  \`await sendEmail({ to, subject, text })\`. It reads \`EMAIL_PROVIDER\`/\`EMAIL_FROM\`
  and the right credentials, and handles each provider's error contract (e.g.
  Resend returns errors instead of throwing). Do not configure your own email
  service or hand-roll the provider logic. Install only the active provider's
  package: \`resend\`, \`googleapis\`, or \`nodemailer\` (check \`EMAIL_PROVIDER\`).
- Expose a health endpoint at the path in \`vibe.app.yaml\` (runtime.healthPath).
- Keep \`.vibe-memory/\` up to date after meaningful changes.

Live data / read-models (REQUIRED when this app has a database):
- The platform lets the user (and LLMs) ask questions about this app's **live
  data** — e.g. "did I buy tomato sauce last month?" — *only* through
  **read-models** you declare in \`vibe.app.yaml\` under \`readModels\`. If you don't
  declare them, that data is invisible to the platform. Treat declaring them as
  part of building any feature that stores data.
- Each read-model is a single **read-only** \`SELECT\` (or \`WITH … SELECT\`) over
  this app's own database, with named, typed params bound as \`$1, $2, …\` in the
  order listed. The platform runs them in a READ ONLY transaction, so they can
  never modify data. Example:
  \`\`\`yaml
  readModels:
    - name: purchases_by_item
      description: Purchases of an item within a date range.
      sql: >
        SELECT purchased_at, item, quantity, amount
        FROM purchases
        WHERE item ILIKE '%' || $1 || '%'
          AND purchased_at >= $2 AND purchased_at < $3
        ORDER BY purchased_at DESC
      params:
        - { name: item, type: string, required: true }
        - { name: from, type: date, required: true }
        - { name: to,   type: date, required: true }
  \`\`\`
- Add or update a read-model whenever you add or change a table the user might
  ask about. Write clear \`description\`s — that's what the LLM reads to pick one.
- Verify with \`vibe doctor\` (it flags a database app with no/invalid read-models)
  and try them with \`vibe query <name> -p key=value\`.
- A \`.gitignore\` is scaffolded for you. **Never commit \`.env\` or secrets**, and
  keep \`node_modules/\` out of git; if it's missing, create one before committing.

Deploying (GitHub is the default path):
- **Credentials:** if any \`vibe\` command reports you are not logged in, stop and
  ask the user for their control-plane URL and owner token, then run
  \`vibe login --url <url> --token <token>\`. Never invent credentials. Pushing to
  GitHub also needs the user's local git auth (e.g. \`gh auth login\`). Run
  \`vibe doctor\` to check both before deploying.
- **To deploy, run \`vibe ship\`. That's the whole thing — one command.** It
  connects the app to GitHub on first run (creates the repo + CI and pushes) and
  commits + pushes on every run after, triggering the build and rollout.
- **You (the agent) run \`vibe ship\` yourself** once the app is ready — do not
  print deploy steps for the user to run. Deploying the app is your job, not the
  user's. The only thing you escalate is missing credentials (above).
- Redeploy after any change by running \`vibe ship\` again.
- The repo's \`Dockerfile\` defines the build; keep it working. (\`custom-dockerfile\`
  apps own theirs; others get one generated from \`vibe.app.yaml\`.)
- Check progress with \`vibe status\` / \`vibe logs\`; the repo's Deployments tab
  also shows rollout state.
`;

// Pointer files so each coding agent loads the same instructions. AGENTS.md is
// the single source of truth; Codex reads it natively. Claude Code (CLAUDE.md)
// and Gemini CLI (GEMINI.md) both support \`@\`-imports, so these pull AGENTS.md
// in rather than duplicating it.
const CLAUDE_MD = `# Project guidance for Claude

The authoritative instructions for this app are in **AGENTS.md** — read it first
and follow it. It explains how this app uses Vibe Base (deploy via git push,
platform auth, environment variables, email, etc.).

@AGENTS.md
`;

const GEMINI_MD = `# Project guidance for Gemini

The authoritative instructions for this app are in **AGENTS.md** — read it first
and follow it. It explains how this app uses Vibe Base (deploy via git push,
platform auth, environment variables, email, etc.).

@AGENTS.md
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
${m.capabilities.email ? "- `EMAIL_PROVIDER` (`resend` | `gmail-api` | `smtp`) + `EMAIL_FROM`. `resend`: `RESEND_API_KEY` (POST to the Resend API / `resend` package). `gmail-api`: `GMAIL_CLIENT_ID/SECRET`, `GMAIL_REFRESH_TOKEN` (the `googleapis` Gmail API). `smtp`: `SMTP_HOST/PORT/USER/PASS/SECURE` (nodemailer)." : ""}
- \`X-Vibe-User-Email\` / \`X-Vibe-User-Role\` request headers (gateway auth).
`;
}

const RUNBOOK_MD = `# Runbook

## Deploy
\`vibe ship\` — one command. First run connects the app to GitHub (repo + CI) and
pushes; later runs commit + push. Either way GitHub Actions builds the image,
the platform pulls it, runs migrations, health-checks, and flips the proxy to
the new version. Rollout state shows up in the repo's Actions / Deployments tab.

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

/**
 * Ready-made email helper scaffolded for Node apps with capabilities.email.
 * Handles all three platform providers and — importantly — checks Resend's
 * { error } return value (the SDK resolves instead of throwing on failure, a
 * common silent-failure trap). Each provider's package is required lazily, so
 * only the active one (resend / googleapis / nodemailer) needs installing.
 */
const EMAIL_HELPER_JS = `// Vibe Base email helper — send via the platform-configured provider.
// Reads EMAIL_PROVIDER + credentials from the environment (injected by Vibe
// Base when capabilities.email is enabled). Install only the active provider's
// package: \`resend\`, \`googleapis\`, or \`nodemailer\`.

async function sendEmail({ to, subject, text, html }) {
  const provider = process.env.EMAIL_PROVIDER;
  const from = process.env.EMAIL_FROM;
  if (!provider) throw new Error('Email is not configured (no EMAIL_PROVIDER).');
  if (!to) throw new Error('sendEmail: "to" is required.');

  if (provider === 'resend') {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    // Resend returns errors instead of throwing — check explicitly.
    const { data, error } = await resend.emails.send({ from, to, subject, text, html });
    if (error) throw new Error('Resend: ' + (error.message || JSON.stringify(error)));
    return { id: data && data.id };
  }

  if (provider === 'gmail-api') {
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const headers = ['From: ' + from, 'To: ' + to, 'Subject: ' + (subject || '')];
    if (html) headers.push('Content-Type: text/html; charset=UTF-8');
    const raw = Buffer.from(headers.join('\\r\\n') + '\\r\\n\\r\\n' + (html || text || ''))
      .toString('base64url');
    const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { id: r.data.id };
  }

  if (provider === 'smtp') {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
    const info = await t.sendMail({ from, to, subject, text, html });
    return { id: info.messageId };
  }

  throw new Error('Unknown EMAIL_PROVIDER: ' + provider);
}

module.exports = { sendEmail };
`;

/** Whether the app is a Node project (so a JS email helper makes sense). */
function isNodeApp(m: Manifest): boolean {
  const lang = (m.runtime.language ?? "").toLowerCase();
  return (
    m.runtime.adapter.startsWith("node-") ||
    lang === "javascript" ||
    lang === "typescript"
  );
}

export async function scaffold(cwd: string, m: Manifest): Promise<ScaffoldResult> {
  const created: string[] = [];
  const memDir = join(cwd, ".vibe-memory");
  const vibeDir = join(cwd, ".vibe");
  await mkdir(memDir, { recursive: true });
  await mkdir(vibeDir, { recursive: true });

  const writes: Array<[string, string]> = [
    [join(cwd, "AGENTS.md"), AGENTS_MD],
    [join(cwd, "CLAUDE.md"), CLAUDE_MD],
    [join(cwd, "GEMINI.md"), GEMINI_MD],
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

  // A correct, ready-to-use email helper for Node apps that send mail.
  if (m.capabilities.email && isNodeApp(m)) {
    const libDir = join(cwd, "lib");
    await mkdir(libDir, { recursive: true });
    if (await writeIfMissing(join(libDir, "email.js"), EMAIL_HELPER_JS)) {
      created.push(join(libDir, "email.js"));
    }
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
