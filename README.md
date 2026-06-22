# Vibe Base

**Virtual Infrastructure for Building Everything** — a local-first base layer
that lets your preferred LLM build, deploy, and operate private apps from your
normal local workflow.

```
mkdir my-app && cd my-app
vibe init
# ...LLM builds the app...
vibe deploy        # → https://my-app.apps.yourdomain.com
```

## What's in this MVP

The spine that produces the magic moment — *describe an app, see it live at a
subdomain, log in, read its state with an LLM*:

- **`vibe` CLI** — `init` (`--github` to create a repo + CI), `detect`,
  `doctor`, `deploy` (`--image` to ship a prebuilt image), `status`, `logs`,
  `context`, `invite`, `apps`, `open`, `deploy rollback`, `github connect`,
  `login`.
- **Control plane** (single VPS) — Fastify API + Postgres that the CLI and
  portal both drive.
- **Deploy engine** — two paths into the same pipeline: either upload a build
  context and build the container on the VPS, **or** pull a prebuilt image from
  a registry (GitHub Actions). Then it provisions a per-app Postgres database +
  MinIO bucket, injects env, runs migrations, health-checks, and flips the Caddy
  route to the new version (old container is kept for rollback).
- **GitHub integration** — `vibe init --github` creates a repo, scaffolds a
  deploy workflow, and wires CI: every push builds + pushes an image to GHCR and
  triggers a deploy. The control plane mirrors rollout state back to the repo's
  GitHub Deployments. Auth is a PAT in the control-plane env (MVP).
- **Gateway auth** — every app sits behind Caddy `forward_auth` → the control
  plane's `/authz`. Apps never implement login; they read the signed-in user
  from `X-Vibe-User-Email` / `X-Vibe-User-Role` headers. Invite-only by default.
- **Owner portal** — served by the control plane behind the same session: app
  list, app detail (status, logs, members, invite, rollback).
- **LLM-readable project files** — `vibe.app.yaml`, `AGENTS.md`, `.vibe-memory/`.

Apps can also send email: enable `capabilities.email` and the platform injects
email env (a single shared sender configured on the control plane). Three
transports are supported, chosen by what you configure. Precedence when several
are set: **Resend > Gmail API > SMTP**.

- **Resend (recommended)** — HTTPS API, no SMTP ports, no OAuth. Sends from a
  domain you verify in Resend.
- **Gmail API** — sends over HTTPS as your Gmail account; works even where
  outbound SMTP is blocked (DigitalOcean blocks ports 25/465/587 by default).
- **SMTP** — simple nodemailer, but needs those ports open.

Apps branch on the injected `EMAIL_PROVIDER` (`resend` | `gmail-api` | `smtp`)
and send as `EMAIL_FROM`.

### Resend setup

1. Create an account at https://resend.com.
2. **Domains → Add domain** → add `yourdomain.com` and create the DNS records it
   shows (SPF/DKIM) at your registrar. Wait for it to verify.
3. **API Keys → Create** → copy the key.
4. In the control plane's `.env`, set `RESEND_API_KEY=re_...` and
   `RESEND_FROM=noreply@yourdomain.com`, then `docker compose up -d`. (For a
   quick test without a verified domain, Resend lets you send from
   `onboarding@resend.dev` to your own account email.)

### Gmail API setup (one-time, to get a refresh token)

1. **Google Cloud** → create/pick a project → **APIs & Services → Library** →
   enable **Gmail API**.
2. **OAuth consent screen** → External → add your Gmail as a **Test user** →
   add scope `https://www.googleapis.com/auth/gmail.send`.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Add `https://developers.google.com/oauthplayground` as an authorized redirect
   URI. Note the **client ID** and **client secret**.
4. Go to **https://developers.google.com/oauthplayground** → gear icon → check
   "Use your own OAuth credentials" → paste the client ID/secret. In the left
   panel enter scope `https://www.googleapis.com/auth/gmail.send` → **Authorize**
   → consent as your Gmail → **Exchange authorization code for tokens**. Copy the
   **refresh token**.
5. Put them in the control plane's `.env`:
   ```
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   GMAIL_REFRESH_TOKEN=...
   GMAIL_FROM=you@gmail.com
   ```
   then `docker compose up -d`. Apps with `capabilities.email` get these next
   deploy.

Deferred (post-MVP, per the spec): backups/restore, app actions + MCP server,
scheduled jobs, custom domains, memory-staleness enforcement.

## Querying the live platform (for LLMs)

A read-only query layer lets you — and an LLM acting on your behalf — *reason
about the running platform*, not just the code. Everything here is deliberately
secret-free: it exposes the **presence and shape** of things (which apps exist,
which secrets are set, which data is queryable), never credential values.

- **Stratum 1 — platform metadata.** Apps, health, deploy history, members, and
  audit trail, scoped to what you can see (owner sees all; a member sees only
  their apps):
  ```bash
  vibe platform              # overview of every app you can see
  vibe platform app <id>     # one app: status, members, secret names, read-models
  ```
- **Stratum 2 — app data via read-models.** Each app declares **read-models** in
  `vibe.app.yaml`: named, typed, single read-only `SELECT`s over its own
  database. The control plane runs them inside a `READ ONLY` transaction (with a
  statement timeout and row cap), so a query can never mutate data. This is what
  answers *"did I buy tomato sauce last month?"* without exposing the app's raw
  schema:
  ```bash
  vibe query                              # list this app's read-models
  vibe query purchases_by_item \
    -p item=tomato -p from=2026-05-01 -p to=2026-06-01
  ```

Apps with a database are expected to declare read-models for anything a user
might ask about; the scaffolded `AGENTS.md` instructs coding agents to do this,
and `vibe doctor` flags a database app with missing or invalid read-models. The
same surface is also served over HTTP under `/api/platform/*` behind the gateway
session/role model, ready for a portal assistant or remote relay to consume.

## Architecture

```
VPS (docker-compose, one network "vibe")
 ├─ control-plane (TypeScript / Fastify) ← the CLI + portal talk to this
 ├─ postgres   (platform DB + one database per app)
 ├─ caddy      (*.apps.domain, admin API, forward_auth, on-demand TLS)
 ├─ minio      (S3-compatible storage, one bucket per app)
 └─ docker     (builds + runs app containers; control plane drives the socket)
```

Request path for an app:

```
browser → caddy → /authz (control plane)
                    ├─ no session  → 302 to /login
                    ├─ not a member → 403
                    └─ ok → inject X-Vibe-User-* → proxy to app container
```

## Repository layout

```
packages/
  shared/         @vibe/shared        — manifest schema (zod) + API contracts
  control-plane/  @vibe/control-plane — Fastify API, deploy engine, auth, portal
  cli/            @vibe/cli           — the `vibe` command
infra/caddy.json                      — Caddy bootstrap (admin API on the network)
docker-compose.yml                    — the whole stack
examples/sample-app/                  — minimal app that validates the spine
```

## Running the control plane (VPS)

1. Point DNS at the VPS: `*.apps.example.com` and `vibe.example.com`.
2. `cp .env.example .env` and fill it in (domains, owner, secrets).
3. `docker compose up -d --build`

The control plane runs migrations, ensures the owner account, and programs
Caddy's base config on boot.

## Using it from your machine

```bash
npm install && npm run build            # build the workspace
node packages/cli/dist/index.js login --url https://vibe.example.com --token <OWNER_TOKEN>

cd examples/sample-app
vibe deploy                             # → https://sample-app.apps.example.com
vibe status
vibe invite friend@example.com --role member
vibe delete                             # tear down container, db, storage, routing, records
```

> The CLI authenticates as the owner with the bearer token. Browser login
> (portal + apps) uses `OWNER_PASSWORD`, or the `OWNER_TOKEN` if that's unset.

## Deploying through GitHub (build in CI, pull on the VPS)

Instead of building on the VPS, let GitHub Actions build the image and have the
control plane pull it — this keeps the memory-hungry builds off the droplet.

**One-time control-plane setup** (in `.env`):

- `GITHUB_TOKEN` — a PAT with `repo` + `read:packages`/`write:packages`. Used to
  create repos, set Actions secrets, and post deployment status.
- `GHCR_USERNAME` / `GHCR_TOKEN` — credentials the VPS uses to `docker login
  ghcr.io` so it can pull private app images (`read:packages` is enough).
- Optional: `GITHUB_DEFAULT_OWNER` (+ `GITHUB_OWNER_IS_ORG=true`) to create
  repos under an org instead of the token's own account.

**Per app**, from your machine:

```bash
cd my-app
vibe init --github       # creates the repo, scaffolds .github/workflows/deploy.yml,
                         # sets CI secrets/vars, and pushes the code
# ...or, for an app that already has a manifest:
vibe github connect
```

From then on, every push to `main` builds an image, pushes it to
`ghcr.io/<owner>/<app>:<sha>`, and calls the control plane to roll it out. The
rollout shows up under the repo's **Deployments**. You can also deploy a
specific prebuilt image manually:

```bash
vibe deploy --image ghcr.io/<owner>/<app>:<sha>
```

The CI flow needs a `Dockerfile` in the repo; `vibe init --github` scaffolds one
from the manifest's runtime adapter (skipped for `custom-dockerfile` apps, which
bring their own).

## Local development of the control plane

`npm run dev:control-plane` runs it with `--watch`. It needs Postgres reachable
via `DATABASE_URL` and (for deploys) a Docker daemon. Caddy/MinIO are optional
for API work — the control plane logs a warning and continues if Caddy's admin
API isn't reachable.

## Deploying to a DigitalOcean droplet

1. **Droplet**: Ubuntu, ≥2 GB RAM (image builds are memory-hungry). Note its IP.
2. **DNS** (at your registrar), both pointing at the droplet IP:
   - `A   vibe.example.com        → <IP>`   (control plane / portal)
   - `A   *.apps.example.com      → <IP>`   (wildcard for apps)
3. **On the droplet** install Docker, get the code, configure, launch:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone <your-repo> /opt/vibe-base && cd /opt/vibe-base
   cp .env.example .env && nano .env          # real domains, TLS_MODE=acme, real secrets
   ufw allow 80 && ufw allow 443 && ufw allow OpenSSH && ufw enable
   docker compose up -d --build               # NO override file in prod → 8080 stays private
   ```
   Generate secrets with `openssl rand -hex 32` (OWNER_TOKEN, SESSION_SECRET,
   POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD). For GitHub-driven deploys also set
   `GITHUB_TOKEN` and `GHCR_USERNAME`/`GHCR_TOKEN` (see the GitHub section above).
4. **From your machine**, point the CLI at the control plane and deploy:
   ```bash
   vibe login --url https://vibe.example.com --token <OWNER_TOKEN>
   cd my-app && vibe deploy            # build on the VPS…
   cd my-app && vibe init --github     # …or wire up GitHub CI deploys
   ```

Caddy obtains real Let's Encrypt certs automatically (`TLS_MODE=acme`). Only
80/443 are exposed; Postgres, MinIO, the Caddy admin API, and the control-plane
API are reachable only on the internal Docker network.
