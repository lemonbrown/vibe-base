import type { FastifyInstance } from "fastify";
import { InviteRequestSchema } from "@vibe/shared";
import { loadConfig } from "../config.js";
import { query } from "../db.js";
import { audit } from "../lib/audit.js";
import { token } from "../lib/ids.js";
import { getApp } from "../repo.js";
import { requireOwner } from "./guards.js";

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  // Invite a user to an app. Returns a claim URL to share (no email needed).
  app.post<{ Params: { id: string } }>("/api/apps/:id/invite", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const appRow = await getApp(req.params.id);
    if (!appRow) return reply.code(404).send({ error: "app not found" });

    const parsed = InviteRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { email, role } = parsed.data;
    const lower = email.toLowerCase();

    await query(
      `INSERT INTO app_members (app_id, email, role, status)
       VALUES ($1, $2, $3, 'invited')
       ON CONFLICT (app_id, email) DO UPDATE SET role = EXCLUDED.role, status = 'invited'`,
      [appRow.id, lower, role]
    );

    const tok = token(24);
    await query(
      `INSERT INTO invites (token, app_id, email, role, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tok, appRow.id, lower, role, new Date(Date.now() + INVITE_TTL_MS)]
    );

    await audit({ actorEmail: actor.email, action: "member.invite", appId: appRow.id, detail: { email: lower, role } });
    const cfg = loadConfig();
    return reply.send({
      email: lower,
      role,
      claimUrl: `https://${cfg.controlPlaneDomain}/claim?token=${tok}`,
    });
  });

  app.get<{ Params: { id: string } }>("/api/apps/:id/members", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const res = await query<{ email: string; role: string; status: string; invited_at: Date }>(
      "SELECT email, role, status, invited_at FROM app_members WHERE app_id = $1 ORDER BY invited_at",
      [req.params.id]
    );
    return reply.send({
      members: res.rows.map((r) => ({
        email: r.email,
        role: r.role,
        status: r.status,
        invitedAt: r.invited_at.toISOString(),
      })),
    });
  });

  app.post<{ Params: { id: string }; Body: { email?: string } }>(
    "/api/apps/:id/revoke",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const email = (req.body?.email ?? "").toLowerCase();
      if (!email) return reply.code(400).send({ error: "email required" });
      await query(
        "UPDATE app_members SET status = 'revoked' WHERE app_id = $1 AND email = $2",
        [req.params.id, email]
      );
      await audit({ actorEmail: actor.email, action: "member.revoke", appId: req.params.id, detail: { email } });
      return reply.send({ revoked: email });
    }
  );
}
