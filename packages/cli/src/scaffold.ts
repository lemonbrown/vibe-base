import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

LLM generation (when \`capabilities.llm: true\` in vibe.app.yaml):
- The platform injects two env vars so your **server** can delegate text generation
  to the owner's local LLM daemon — no API keys needed in the app itself:
  - \`VIBE_CONTROL_URL\` — base URL of the control plane.
  - \`VIBE_OWNER_TOKEN\` — bearer token for the owner's account.
- Call \`POST \${VIBE_CONTROL_URL}/api/apps/\${VIBE_APP_ID}/llm\` from your server code.
  Never expose \`VIBE_OWNER_TOKEN\` to the browser.
- Body: \`{ "prompt": "...", "systemPrompt": "...", "model": "smart" }\` — \`systemPrompt\` is optional;
  use it to set persistent context (e.g. "You are a Bible curriculum assistant.")
  without mixing it into each user prompt. \`model\` is optional and must be one
  of \`"fast"\`, \`"smart"\`, or \`"deep"\`; Vibe Base maps that alias to an
  owner-approved provider model.
- Response: **Server-Sent Events** — each \`data:\` line is a JSON \`JobEvent\`:
  \`{ seq, type, data }\`. Collect \`type === "text"\` payloads; stop on \`type === "done"\`.
- Example (Node/fetch):
  \`\`\`js
  const res = await fetch(\`\${process.env.VIBE_CONTROL_URL}/api/apps/\${process.env.VIBE_APP_ID}/llm\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.VIBE_OWNER_TOKEN}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ systemPrompt: 'You are a Bible curriculum assistant.', model: 'smart', prompt }),
  });
  let output = '';
  for await (const chunk of res.body) {
    for (const line of Buffer.from(chunk).toString().split('\\n')) {
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === 'text') output += ev.data.text ?? '';
      if (ev.type === 'done') break;
    }
  }
  \`\`\`
- The daemon uses the owner's configured provider. Apps may choose only the
  coarse \`fast\` / \`smart\` / \`deep\` model alias; they cannot pass raw provider
  model IDs.

Deploying (GitHub is the default path):
- Use \`vibe test\` for feature verification. It deploys to an isolated test
  environment with its own URL, database, and storage.
- Do not use production for feature testing. After test deployment and
  verification pass, run \`vibe promote\` to roll the tested image to production.
- \`vibe ship\` is GitHub-backed test deployment; after it runs, monitor with
  \`vibe ci --env test\`.
- **Credentials:** if any \`vibe\` command reports you are not logged in, stop and
  ask the user for their control-plane URL and owner token, then run
  \`vibe login --url <url> --token <token>\`. Never invent credentials. Pushing to
  GitHub also needs the user's local git auth (e.g. \`gh auth login\`). Run
  \`vibe doctor\` to check both before deploying.
- **To deploy, run \`vibe ship\`. That's the whole thing — one command.** It
  connects the app to GitHub on first run (creates the repo + CI and pushes) and
  commits + pushes on every run after, triggering the build and rollout.
- **Immediately after \`vibe ship\`, run \`vibe ci\`** to monitor the GitHub Actions
  build. It polls until the run completes and prints the failed step logs if it
  fails. Fix the issue and run \`vibe ship\` again.
- **You (the agent) run \`vibe ship\` and \`vibe ci\` yourself** — do not print
  deploy steps for the user to run. Deploying and monitoring CI is your job.
  The only thing you escalate is missing credentials (above).
- Redeploy after any change by running \`vibe ship\` again (then \`vibe ci\`).
- The repo's \`Dockerfile\` defines the build; keep it working. (\`custom-dockerfile\`
  apps own theirs; others get one generated from \`vibe.app.yaml\`.)
- Check runtime state with \`vibe status\` / \`vibe logs\` after CI passes.
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
${m.capabilities.llm ? "- `VIBE_CONTROL_URL` — control-plane base URL for LLM proxy calls.\n- `VIBE_OWNER_TOKEN` — bearer token; authenticate server-side LLM requests. Never expose to the browser." : ""}
- \`X-Vibe-User-Email\` / \`X-Vibe-User-Role\` request headers (gateway auth).
`;
}

const RUNBOOK_MD = `# Runbook

## Deploy
\`vibe ship\` — one command. First run connects the app to GitHub (repo + CI) and
pushes; later runs commit + push. Either way GitHub Actions builds the image,
the platform pulls it, runs migrations, health-checks, and flips the proxy to
the new version.

After every \`vibe ship\`, run \`vibe ci\` to monitor the GitHub Actions build.
It polls until the run completes and prints failed step logs on failure — fix
the issue and re-ship. Requires \`gh\` CLI installed and authenticated.

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

export interface PwaScaffoldResult extends ScaffoldResult {
  registered: boolean;
  notes: string[];
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
  if (!to) throw new Error('sendEmail: "to" is required.');

  if (process.env.EMAIL_CAPTURE === 'true' || process.env.VIBE_ENV === 'test') {
    console.log('[email:capture]', JSON.stringify({ to, subject, text, html }));
    return { id: 'captured-' + Date.now() };
  }

  if (!provider) throw new Error('Email is not configured (no EMAIL_PROVIDER).');

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
          VIBE_DEPLOY_ENV: \${{ vars.VIBE_DEPLOY_ENV || 'test' }}
          VIBE_DEPLOY_TOKEN: \${{ secrets.VIBE_DEPLOY_TOKEN }}
          IMAGE: \${{ steps.img.outputs.image }}:\${{ github.sha }}
        run: |
          curl -fsS -X POST "$VIBE_API_URL/api/apps/$VIBE_APP_ID/deploy/image" \\
            -H "authorization: Bearer $VIBE_DEPLOY_TOKEN" \\
            -H "content-type: application/json" \\
            -d "{\\"image\\":\\"$IMAGE\\",\\"sha\\":\\"\${{ github.sha }}\\",\\"ref\\":\\"\${{ github.ref }}\\",\\"env\\":\\"$VIBE_DEPLOY_ENV\\"}"
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

function pwaIconSvg(background: string, maskable = false): string {
  const bg = background || "#0b0d12";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    maskable
      ? `  <rect width="512" height="512" fill="${bg}"/>`
      : `  <rect width="512" height="512" rx="96" fill="${bg}"/>`,
    maskable ? `  <circle cx="256" cy="256" r="224" fill="#11141c"/>` : "",
    `  <path d="M126 132h260L276 380h-40L126 132Z" fill="#5b7cff"/>`,
    `  <path d="M204 132h104l-52 126-52-126Z" fill="#e7e9ee"/>`,
    `  <path d="M168 190h176l-75 166h-26L168 190Z" fill="${bg}" opacity=".45"/>`,
    `</svg>`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");
}

function pwaManifest(m: Manifest): string {
  const pwa = m.pwa;
  const name = pwa?.name ?? m.name;
  const shortName = pwa?.shortName ?? name.slice(0, 12);
  return JSON.stringify(
    {
      name,
      short_name: shortName,
      description: m.description || undefined,
      start_url: "/",
      scope: "/",
      display: pwa?.display ?? "standalone",
      background_color: pwa?.backgroundColor ?? "#0b0d12",
      theme_color: pwa?.themeColor ?? "#0b0d12",
      icons: [
        {
          src: "/icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any",
        },
        {
          src: "/maskable-icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "maskable",
        },
      ],
    },
    null,
    2
  ) + "\n";
}

function pwaServiceWorker(m: Manifest): string {
  const cacheName = `vibe-app-${m.id}-pwa-v1`;
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/maskable-icon.svg"];
const NETWORK_ONLY_PREFIXES = ["/api", "/login", "/logout", "/claim", "/health"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response.ok) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
`;
}

const PWA_REGISTER_JS = `if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}
`;

function injectIntoHtml(html: string, themeColor: string): { html: string; changed: boolean } {
  let out = html;
  let changed = false;
  const headTags = [
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
    `<meta name="theme-color" content="${themeColor}">`,
  ];
  for (const tag of headTags) {
    if (out.includes(tag)) continue;
    out = out.replace(/<\/head>/i, `    ${tag}\n  </head>`);
    changed = true;
  }

  const registerTag = `<script src="/vibe-pwa-register.js" defer></script>`;
  if (!out.includes(registerTag)) {
    out = out.replace(/<\/body>/i, `    ${registerTag}\n  </body>`);
    changed = true;
  }
  return { html: out, changed };
}

export async function scaffoldPwa(cwd: string, m: Manifest): Promise<PwaScaffoldResult> {
  const created: string[] = [];
  const notes: string[] = [];
  const publicDir = join(cwd, "public");
  await mkdir(publicDir, { recursive: true });

  const writes: Array<[string, string]> = [
    [join(publicDir, "manifest.webmanifest"), pwaManifest(m)],
    [join(publicDir, "sw.js"), pwaServiceWorker(m)],
    [join(publicDir, "vibe-pwa-register.js"), PWA_REGISTER_JS],
    [join(publicDir, "icon.svg"), pwaIconSvg(m.pwa?.backgroundColor ?? "#0b0d12")],
    [join(publicDir, "maskable-icon.svg"), pwaIconSvg(m.pwa?.backgroundColor ?? "#0b0d12", true)],
  ];

  for (const [p, content] of writes) {
    await writeFile(p, content, "utf8");
    created.push(p);
  }

  const indexPath = join(cwd, "index.html");
  let registered = false;
  try {
    const current = await readFile(indexPath, "utf8");
    const injected = injectIntoHtml(current, m.pwa?.themeColor ?? "#0b0d12");
    if (injected.changed) await writeFile(indexPath, injected.html, "utf8");
    registered = true;
    if (injected.changed) created.push(indexPath);
  } catch {
    notes.push(
      "No index.html found, so service worker registration was not injected. Add /vibe-pwa-register.js to your HTML entrypoint."
    );
  }

  return { created, registered, notes };
}

function envExample(m: Manifest): string {
  const lines = ["# Platform-provided (do not set manually):", "# PORT", "# VIBE_APP_ID", "# VIBE_ENV"];
  if (m.capabilities.database) lines.push("# DATABASE_URL");
  if (m.capabilities.storage)
    lines.push("# S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  if (m.capabilities.email)
    lines.push(
      "# EMAIL_PROVIDER, EMAIL_FROM (+ GMAIL_* for gmail-api, or SMTP_* for smtp)"
    );
  if (m.capabilities.email) lines.push("# EMAIL_CAPTURE (true in test deployments)");
  if (m.capabilities.llm)
    lines.push("# VIBE_CONTROL_URL", "# VIBE_OWNER_TOKEN");
  lines.push("", "# Your app's own variables go below (set with `vibe env set`):");
  return lines.join("\n") + "\n";
}

const DOCKERIGNORE = `node_modules
.git
.next
dist
.turbo
tmp
.env
.env.local
*.log
*.db
*.db-shm
*.db-wal
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.sqlite3
*.sqlite3-shm
*.sqlite3-wal
.vibe/state.json
`;

const GITIGNORE = `# Dependencies / build output
node_modules/
dist/
.next/
build/
*.log
.turbo/

# Local/test databases - production gets platform-provided DATABASE_URL instead
*.db
*.db-shm
*.db-wal
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.sqlite3
*.sqlite3-shm
*.sqlite3-wal

# Secrets — never commit these
.env
.env.local
.env.*.local

# Vibe Base local state (keep .vibe-memory/ — it is meant to be committed)
.vibe/state.json

# OS / editor
.DS_Store
`;
