import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config.js";
import { query } from "../db.js";
import { getActor, isOwner, type Actor } from "../auth/session.js";
import { containerLogs } from "../services/docker.js";
import { isDatabaseProvisioned } from "../services/dbProvision.js";
import { isStorageProvisioned } from "../services/storage.js";
import {
  appSummary,
  getApp,
  getDeployment,
  listApps,
  recentDeployments,
} from "../repo.js";

/** Gate a portal page on an owner session; redirect to /login otherwise. */
async function ownerPage(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<Actor | null> {
  const actor = await getActor(req);
  if (isOwner(actor)) return actor;
  const cfg = loadConfig();
  const next = `https://${cfg.controlPlaneDomain}${req.url}`;
  reply.redirect(`https://${cfg.controlPlaneDomain}/login?next=${encodeURIComponent(next)}`);
  return null;
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #0b0d12; color: #e7e9ee; }
  header { padding: 16px 28px; border-bottom: 1px solid #1c2130; display:flex; justify-content:space-between; align-items:center; }
  .brand { font-weight: 700; letter-spacing:.04em; color:#5b7cff; }
  main { max-width: 860px; margin: 0 auto; padding: 28px; }
  a { color: #8ea2ff; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid #1c2130; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border:1px solid #2a3043; }
  .ok { color:#5fe3a1; border-color:#234; } .warn { color:#ffcd6b; } .bad { color:#ff7a85; }
  .card { border:1px solid #1c2130; border-radius:12px; padding:18px; margin:16px 0; }
  pre { background:#070910; padding:14px; border-radius:8px; overflow:auto; max-height:340px; font-size:12px; }
  h1 { font-size:18px; } h2 { font-size:14px; color:#8b93a7; text-transform:uppercase; letter-spacing:.06em; }
  button, input, select { font: inherit; }
  input, select { background:#0b0d12; color:#e7e9ee; border:1px solid #2a3043; border-radius:7px; padding:8px; }
  button { background:#5b7cff; color:#fff; border:0; border-radius:7px; padding:8px 14px; cursor:pointer; }
  form.inline { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title><style>${STYLE}</style></head><body>
    <header><div><span class="brand">Vibe</span> Base</div>
      <form method="post" action="/logout" style="margin:0"><button>Sign out</button></form>
    </header><main>${body}</main></body></html>`;
}

function healthPill(h: string): string {
  const cls = h === "healthy" ? "ok" : h === "unhealthy" ? "bad" : "warn";
  return `<span class="pill ${cls}">${h}</span>`;
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  // App list (home).
  app.get("/", async (req, reply) => {
    const actor = await ownerPage(req, reply);
    if (!actor) return;
    const rows = await listApps();
    const apps = await Promise.all(rows.map(appSummary));
    const list =
      apps
        .map(
          (a) => `<tr>
            <td><a href="/apps/${a.id}">${esc(a.name)}</a></td>
            <td>${healthPill(a.health)}</td>
            <td><span class="pill">${a.status}</span></td>
            <td>${a.url ? `<a href="${a.url}">${esc(a.url)}</a>` : "—"}</td>
          </tr>`
        )
        .join("") || `<tr><td colspan="4">No apps yet. Create one with <code>vibe init</code> + <code>vibe deploy</code>.</td></tr>`;
    return reply
      .type("text/html")
      .send(
        shell(
          "My Apps · Vibe Base",
          `<h1>My Apps</h1><div class="card"><table>
            <tr><th>App</th><th>Health</th><th>Status</th><th>URL</th></tr>${list}</table></div>`
        )
      );
  });

  // App detail.
  app.get<{ Params: { id: string } }>("/apps/:id", async (req, reply) => {
    const actor = await ownerPage(req, reply);
    if (!actor) return;
    const row = await getApp(req.params.id);
    if (!row) return reply.code(404).type("text/html").send(shell("Not found", "<p>App not found.</p>"));

    const summary = await appSummary(row);
    const deps = await recentDeployments(row.id, 5);
    const cur = row.current_deployment_id ? await getDeployment(row.current_deployment_id) : null;
    const runtimeLog = cur?.container_name ? await containerLogs(cur.container_name, 120) : "";
    const dbOn = row.manifest.capabilities.database;
    const stOn = row.manifest.capabilities.storage;

    const members = await query<{ email: string; role: string; status: string }>(
      "SELECT email, role, status FROM app_members WHERE app_id = $1 ORDER BY invited_at",
      [row.id]
    );
    const memberRows = members.rows
      .map(
        (m) => `<tr><td>${esc(m.email)}</td><td>${m.role}</td><td><span class="pill">${m.status}</span></td></tr>`
      )
      .join("");

    const depRows = deps
      .map(
        (d) => `<tr><td>${d.created_at.toISOString()}</td><td>${d.status}</td><td>${esc(d.id)}</td></tr>`
      )
      .join("");

    const body = `
      <p><a href="/">← All apps</a></p>
      <h1>${esc(row.name)} ${healthPill(summary.health)}</h1>
      <div class="card">
        <table>
          <tr><td>Status</td><td>${summary.status}</td></tr>
          <tr><td>URL</td><td>${summary.url ? `<a href="${summary.url}">${esc(summary.url)}</a>` : "(not deployed)"}</td></tr>
          <tr><td>Runtime</td><td>${row.manifest.runtime.adapter} · port ${row.manifest.runtime.port}</td></tr>
          <tr><td>Database</td><td>${dbOn ? (await isDatabaseProvisioned(row.id) ? "provisioned" : "enabled") : "off"}</td></tr>
          <tr><td>Storage</td><td>${stOn ? (await isStorageProvisioned(row.id) ? "provisioned" : "enabled") : "off"}</td></tr>
        </table>
        <form class="inline" method="post" action="/apps/${row.id}/rollback">
          <button>Roll back</button>
          ${summary.url ? `<a class="pill" href="${summary.url}">Open app ↗</a>` : ""}
        </form>
      </div>

      <div class="card">
        <h2>Members</h2>
        <table><tr><th>Email</th><th>Role</th><th>Status</th></tr>${memberRows || `<tr><td colspan=3>Just you.</td></tr>`}</table>
        <form class="inline" method="post" action="/apps/${row.id}/invite-form">
          <input name="email" type="email" placeholder="email to invite" required>
          <select name="role"><option value="member">member</option><option value="leader">leader</option></select>
          <button>Invite</button>
        </form>
      </div>

      <div class="card"><h2>Recent deployments</h2>
        <table><tr><th>When</th><th>Status</th><th>ID</th></tr>${depRows || "<tr><td colspan=3>None.</td></tr>"}</table>
      </div>

      <div class="card"><h2>Runtime logs</h2><pre>${esc(runtimeLog) || "(no logs)"}</pre></div>
      <div class="card"><h2>Build log (current)</h2><pre>${esc(cur?.build_log ?? "") || "(none)"}</pre></div>

      <div class="card" style="border-color:#5a2730">
        <h2 class="bad">Danger zone</h2>
        <p>Permanently delete this app: its container, database, storage bucket,
           routing, and all records. This cannot be undone. Your GitHub repo is
           left untouched.</p>
        <form class="inline" method="post" action="/apps/${row.id}/delete"
              onsubmit="return confirm('Permanently delete ${esc(row.name)}? This cannot be undone.')">
          <input name="confirm" placeholder="type ${esc(row.id)} to confirm" required>
          <button style="background:#b3303c">Delete app</button>
        </form>
      </div>
    `;
    return reply.type("text/html").send(shell(`${row.name} · Vibe Base`, body));
  });

  // Portal form posts (owner session) → redirect back to the detail page.
  app.post<{ Params: { id: string } }>("/apps/:id/rollback", async (req, reply) => {
    const actor = await ownerPage(req, reply);
    if (!actor) return;
    try {
      await app.inject({
        method: "POST",
        url: `/api/apps/${req.params.id}/rollback`,
        headers: { authorization: `Bearer ${loadConfig().ownerToken}` },
      });
    } catch {
      /* surfaced on the page reload */
    }
    return reply.redirect(`/apps/${req.params.id}`);
  });

  app.post<{ Params: { id: string }; Body: { email?: string; role?: string } }>(
    "/apps/:id/invite-form",
    async (req, reply) => {
      const actor = await ownerPage(req, reply);
      if (!actor) return;
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${req.params.id}/invite`,
        headers: {
          authorization: `Bearer ${loadConfig().ownerToken}`,
          "content-type": "application/json",
        },
        payload: { email: req.body?.email ?? "", role: req.body?.role ?? "member" },
      });
      const claim = (res.json() as { claimUrl?: string }).claimUrl ?? "";
      return reply
        .type("text/html")
        .send(
          shell(
            "Invite created",
            `<p><a href="/apps/${req.params.id}">← Back</a></p>
             <div class="card"><h2>Invite created</h2>
             <p>Share this claim link with the invited user:</p>
             <pre>${esc(claim)}</pre></div>`
          )
        );
    }
  );

  // Hard delete from the portal: requires the typed confirmation to equal the
  // app id, then runs the same teardown as the API and returns to the list.
  app.post<{ Params: { id: string }; Body: { confirm?: string } }>(
    "/apps/:id/delete",
    async (req, reply) => {
      const actor = await ownerPage(req, reply);
      if (!actor) return;
      if (req.body?.confirm !== req.params.id) {
        return reply.redirect(`/apps/${req.params.id}`);
      }
      await app.inject({
        method: "DELETE",
        url: `/api/apps/${req.params.id}?confirm=${encodeURIComponent(req.params.id)}`,
        headers: { authorization: `Bearer ${loadConfig().ownerToken}` },
      });
      return reply.redirect("/");
    }
  );
}
