import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config.js";
import { one, query } from "../db.js";
import { audit } from "../lib/audit.js";
import {
  createSession,
  destroySession,
  getActor,
  hashPassword,
  verifyPassword,
  SESSION_COOKIE,
} from "../auth/session.js";
import { clearSessionCookie, setSessionCookie } from "../auth/cookies.js";
import { claimPage, loginPage } from "../auth/pages.js";

interface AppLite {
  id: string;
  subdomain: string;
  access_mode: string;
  default_role: string;
}

function subdomainOf(host: string | undefined, appsDomain: string): string | null {
  if (!host) return null;
  const suffix = `.${appsDomain}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

async function appByHost(host: string | undefined): Promise<AppLite | null> {
  const cfg = loadConfig();
  const sub = subdomainOf(host, cfg.appsDomain);
  if (!sub) return null;
  const exact = await one<AppLite>(
    "SELECT id, subdomain, access_mode, default_role FROM apps WHERE subdomain = $1",
    [sub]
  );
  if (exact) return exact;
  if (!sub.endsWith("-test")) return null;
  return one<AppLite>(
    "SELECT id, subdomain, access_mode, default_role FROM apps WHERE subdomain = $1",
    [sub.slice(0, -"-test".length)]
  );
}

function safeNext(next: string | undefined): string {
  const cfg = loadConfig();
  if (!next) return `https://${cfg.controlPlaneDomain}/`;
  try {
    const u = new URL(next);
    const ok =
      u.hostname === cfg.controlPlaneDomain || u.hostname.endsWith(`.${cfg.appsDomain}`);
    return ok ? u.toString() : `https://${cfg.controlPlaneDomain}/`;
  } catch {
    return `https://${cfg.controlPlaneDomain}/`;
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------- forward-auth (Caddy) ----------------------- */
  app.get("/authz", async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = loadConfig();
    const host = req.headers["x-vibe-app-host"] as string | undefined;
    const uri = (req.headers["x-forwarded-uri"] as string | undefined) ?? "/";
    const appRow = await appByHost(host);
    if (!appRow) return reply.code(404).send("unknown app");

    if (appRow.access_mode === "open") {
      return reply
        .header("X-Vibe-User-Email", "")
        .header("X-Vibe-User-Role", "anon")
        .code(200)
        .send();
    }

    const actor = await getActor(req);
    if (!actor) {
      const next = `https://${host}${uri}`;
      const loginUrl = `https://${cfg.controlPlaneDomain}/login?next=${encodeURIComponent(next)}`;
      return reply.code(302).header("location", loginUrl).send();
    }

    if (actor.role === "owner") {
      return reply
        .header("X-Vibe-User-Email", actor.email)
        .header("X-Vibe-User-Role", "owner")
        .code(200)
        .send();
    }

    const member = await one<{ role: string }>(
      "SELECT role FROM app_members WHERE app_id = $1 AND email = $2 AND status = 'active'",
      [appRow.id, actor.email]
    );
    if (!member) return reply.code(403).send("not a member of this app");

    return reply
      .header("X-Vibe-User-Email", actor.email)
      .header("X-Vibe-User-Role", member.role)
      .code(200)
      .send();
  });

  /* --------------------- on-demand TLS permission --------------------- */
  app.get<{ Querystring: { domain?: string } }>("/tls-check", async (req, reply) => {
    const cfg = loadConfig();
    const domain = req.query.domain ?? "";
    if (domain === cfg.controlPlaneDomain) return reply.code(200).send();
    const appRow = await appByHost(domain);
    return appRow ? reply.code(200).send() : reply.code(403).send();
  });

  /* ------------------------------ login ------------------------------- */
  app.get<{ Querystring: { next?: string } }>("/login", async (req, reply) => {
    return reply.type("text/html").send(loginPage(req.query.next ?? ""));
  });

  app.post<{ Body: { email?: string; password?: string; next?: string } }>(
    "/login",
    async (req, reply) => {
      const { email = "", password = "", next } = req.body ?? {};
      const user = await one<{ email: string; password_hash: string | null }>(
        "SELECT email, password_hash FROM users WHERE email = $1 AND status = 'active'",
        [email.toLowerCase().trim()]
      );
      const ok = user && (await verifyPassword(password, user.password_hash));
      if (!ok) {
        await audit({ actorEmail: email, action: "login.fail", success: false });
        return reply
          .code(401)
          .type("text/html")
          .send(loginPage(next ?? "", "Incorrect email or password."));
      }
      const sid = await createSession(user!.email);
      setSessionCookie(reply, sid);
      await audit({ actorEmail: user!.email, action: "login.success" });
      return reply.redirect(safeNext(next));
    }
  );

  app.post("/logout", async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) await destroySession(sid);
    clearSessionCookie(reply);
    return reply.redirect(`https://${loadConfig().controlPlaneDomain}/login`);
  });

  /* --------------------------- claim invite --------------------------- */
  app.get<{ Querystring: { token?: string } }>("/claim", async (req, reply) => {
    const inv = await resolveInvite(req.query.token);
    if (!inv) return reply.code(400).type("text/html").send(loginPage("", "Invite is invalid or expired."));
    return reply.type("text/html").send(claimPage(inv.token, inv.email));
  });

  app.post<{ Body: { token?: string; password?: string } }>("/claim", async (req, reply) => {
    const { token: tok, password = "" } = req.body ?? {};
    const inv = await resolveInvite(tok);
    if (!inv) return reply.code(400).type("text/html").send(loginPage("", "Invite is invalid or expired."));
    if (password.length < 8) {
      return reply.code(400).type("text/html").send(claimPage(inv.token, inv.email, "Password must be at least 8 characters."));
    }

    const hash = await hashPassword(password);
    const cfg = loadConfig();

    if (inv.kind === "portal") {
      await query(
        `INSERT INTO users (email, role, password_hash, status)
         VALUES ($1, 'member', $2, 'active')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
        [inv.email, hash]
      );
      await query("UPDATE portal_invites SET claimed_at = now() WHERE token = $1", [inv.token]);
      const sid = await createSession(inv.email);
      setSessionCookie(reply, sid);
      await audit({ actorEmail: inv.email, action: "portal.invite.claim" });
      return reply.redirect(`https://${cfg.controlPlaneDomain}/`);
    }

    // App invite
    await query(
      `INSERT INTO users (email, role, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
      [inv.email, inv.role, hash]
    );
    await query(
      "UPDATE app_members SET status = 'active' WHERE app_id = $1 AND email = $2",
      [inv.app_id, inv.email]
    );
    await query("UPDATE invites SET claimed_at = now() WHERE token = $1", [inv.token]);
    const sid = await createSession(inv.email);
    setSessionCookie(reply, sid);
    await audit({ actorEmail: inv.email, action: "invite.claim", appId: inv.app_id });
    const sub = await one<{ subdomain: string }>("SELECT subdomain FROM apps WHERE id = $1", [inv.app_id]);
    return reply.redirect(`https://${sub?.subdomain}.${cfg.appsDomain}/`);
  });
}

type ResolvedInvite =
  | { kind: "portal"; token: string; email: string }
  | { kind: "app"; token: string; app_id: string; email: string; role: string };

async function resolveInvite(tok: string | undefined): Promise<ResolvedInvite | null> {
  if (!tok) return null;

  const portal = await one<{ token: string; email: string }>(
    "SELECT token, email FROM portal_invites WHERE token = $1 AND claimed_at IS NULL AND expires_at > now()",
    [tok]
  );
  if (portal) return { kind: "portal", ...portal };

  const app = await one<{ token: string; app_id: string; email: string; role: string }>(
    "SELECT token, app_id, email, role FROM invites WHERE token = $1 AND claimed_at IS NULL AND expires_at > now()",
    [tok]
  );
  if (app) return { kind: "app", ...app };

  return null;
}
