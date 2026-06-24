import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { one, query } from "../db.js";
import { audit } from "../lib/audit.js";
import { token } from "../lib/ids.js";
import { emailConfigured, sendEmail } from "../services/email.js";
import { requireOwner } from "./guards.js";

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export async function portalMemberRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string } }>("/api/portal/invite", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const email = (req.body?.email ?? "").toLowerCase().trim();
    if (!email || !email.includes("@")) {
      return reply.code(400).send({ error: "valid email required" });
    }

    const cfg = loadConfig();
    if (email === cfg.ownerEmail.toLowerCase()) {
      return reply.code(400).send({ error: "owner cannot be invited as a member" });
    }

    const tok = token(24);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await query(
      "INSERT INTO portal_invites (token, email, expires_at) VALUES ($1, $2, $3)",
      [tok, email, expiresAt]
    );

    const claimUrl = `https://${cfg.controlPlaneDomain}/claim?token=${tok}`;
    let sent = false;
    if (emailConfigured()) {
      sent = await sendEmail({
        to: email,
        subject: `You're invited to ${cfg.controlPlaneDomain}`,
        html: inviteHtml(claimUrl, cfg.controlPlaneDomain),
      });
    }

    await audit({ actorEmail: actor.email, action: "portal.invite", detail: { email, sent } });
    return reply.send({ email, sent, claimUrl: sent ? undefined : claimUrl });
  });

  app.get("/api/portal/members", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const users = await query<{ email: string; status: string; created_at: Date }>(
      "SELECT email, status, created_at FROM users WHERE role = 'member' ORDER BY created_at DESC"
    );

    const pending = await query<{ email: string; created_at: Date }>(
      `SELECT email, created_at FROM portal_invites
        WHERE claimed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`
    );

    const activeEmails = new Set(users.rows.map((r) => r.email));
    const members = [
      ...users.rows.map((r) => ({
        email: r.email,
        status: r.status as "active" | "revoked",
        joinedAt: r.created_at.toISOString(),
      })),
      ...pending.rows
        .filter((inv) => !activeEmails.has(inv.email))
        .map((inv) => ({
          email: inv.email,
          status: "invited" as const,
          invitedAt: inv.created_at.toISOString(),
        })),
    ];

    return reply.send({ members, emailConfigured: emailConfigured() });
  });

  app.delete<{ Params: { email: string } }>("/api/portal/members/:email", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;

    const email = decodeURIComponent(req.params.email).toLowerCase();
    await query("UPDATE users SET status = 'revoked' WHERE email = $1 AND role = 'member'", [email]);
    await query(
      "UPDATE portal_invites SET expires_at = now() WHERE email = $1 AND claimed_at IS NULL",
      [email]
    );

    await audit({ actorEmail: actor.email, action: "portal.revoke", detail: { email } });
    return reply.send({ revoked: email });
  });

  app.get("/api/portal/email-configured", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    return reply.send({ configured: emailConfigured() });
  });
}

function inviteHtml(claimUrl: string, domain: string): string {
  return `<!doctype html>
<html>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0d12;color:#e7e9ee;padding:40px 20px;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#11141c;border:1px solid #1f2533;border-radius:16px;padding:32px;">
    <p style="margin:0 0 4px;font-size:18px;font-weight:600;"><span style="color:#5b7cff;">Vibe</span> Base</p>
    <p style="color:#8b93a7;margin:0 0 24px;font-size:14px;">You've been invited to join ${domain}.</p>
    <a href="${claimUrl}" style="display:block;background:#5b7cff;color:#fff;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">Accept invite</a>
    <p style="color:#8b93a7;font-size:12px;margin:20px 0 0;">Or paste this link into your browser:<br>${claimUrl}</p>
  </div>
</body>
</html>`;
}
