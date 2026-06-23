import type { FastifyInstance } from "fastify";
import type { OwnerSettings } from "@vibe/shared";
import { one, query } from "../db.js";
import { audit } from "../lib/audit.js";
import { requireOwner } from "./guards.js";

interface SettingsRow {
  stack_policy: string;
  plan_mode_default: boolean;
}

const DEFAULTS: OwnerSettings = { stackPolicy: "", planModeDefault: false };

function toSettings(row: SettingsRow | null): OwnerSettings {
  if (!row) return DEFAULTS;
  return { stackPolicy: row.stack_policy, planModeDefault: row.plan_mode_default };
}

/** Load the owner's chat settings, or platform defaults if none saved yet. */
export async function loadOwnerSettings(email: string): Promise<OwnerSettings> {
  const row = await one<SettingsRow>(
    "SELECT stack_policy, plan_mode_default FROM owner_settings WHERE owner_email = $1",
    [email]
  );
  return toSettings(row);
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    return reply.send({ settings: await loadOwnerSettings(actor.email) });
  });

  app.put<{ Body: { stackPolicy?: string; planModeDefault?: boolean } }>(
    "/api/settings",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;

      // Merge over whatever is stored so a partial update leaves the rest intact.
      const current = await loadOwnerSettings(actor.email);
      const stackPolicy =
        typeof req.body?.stackPolicy === "string"
          ? req.body.stackPolicy
          : current.stackPolicy;
      const planModeDefault =
        typeof req.body?.planModeDefault === "boolean"
          ? req.body.planModeDefault
          : current.planModeDefault;

      await query(
        `INSERT INTO owner_settings (owner_email, stack_policy, plan_mode_default, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (owner_email) DO UPDATE SET
           stack_policy = EXCLUDED.stack_policy,
           plan_mode_default = EXCLUDED.plan_mode_default,
           updated_at = now()`,
        [actor.email, stackPolicy, planModeDefault]
      );
      await audit({ actorEmail: actor.email, action: "settings.update" });

      return reply.send({ settings: { stackPolicy, planModeDefault } });
    }
  );
}
