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

- **`vibe` CLI** — `init`, `detect`, `doctor`, `deploy`, `status`, `logs`,
  `context`, `invite`, `apps`, `open`, `deploy rollback`, `login`.
- **Control plane** (single VPS) — Fastify API + Postgres that the CLI and
  portal both drive.
- **Deploy engine** — uploads a build context, builds a container, provisions a
  per-app Postgres database + MinIO bucket, injects env, runs migrations,
  health-checks, then flips the Caddy route to the new version (old container is
  kept for rollback).
- **Gateway auth** — every app sits behind Caddy `forward_auth` → the control
  plane's `/authz`. Apps never implement login; they read the signed-in user
  from `X-Vibe-User-Email` / `X-Vibe-User-Role` headers. Invite-only by default.
- **Owner portal** — served by the control plane behind the same session: app
  list, app detail (status, logs, members, invite, rollback).
- **LLM-readable project files** — `vibe.app.yaml`, `AGENTS.md`, `.vibe-memory/`.

Deferred (post-MVP, per the spec): backups/restore, app actions + MCP server,
scheduled jobs, email, custom domains, memory-staleness enforcement.

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
```

> The CLI authenticates as the owner with the bearer token. Browser login
> (portal + apps) uses `OWNER_PASSWORD`, or the `OWNER_TOKEN` if that's unset.

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
   POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD).
4. **From your machine**, point the CLI at the control plane and deploy:
   ```bash
   vibe login --url https://vibe.example.com --token <OWNER_TOKEN>
   cd my-app && vibe deploy
   ```

Caddy obtains real Let's Encrypt certs automatically (`TLS_MODE=acme`). Only
80/443 are exposed; Postgres, MinIO, the Caddy admin API, and the control-plane
API are reachable only on the internal Docker network.
