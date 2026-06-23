import type { FastifyInstance } from "fastify";
import type { LlmProvider, OwnerSettings } from "@vibe/shared";
import { one, query } from "../db.js";
import { audit } from "../lib/audit.js";
import { requireOwner } from "./guards.js";

interface SettingsRow {
  stack_policy: string;
  plan_mode_default: boolean;
  llm_provider: string;
  llm_model: string;
}

const PROVIDERS: LlmProvider[] = ["claude", "codex"];
const DEFAULTS: OwnerSettings = {
  stackPolicy: "",
  planModeDefault: false,
  llmProvider: "claude",
  llmModel: "sonnet",
};

function normalizeProvider(value: unknown, fallback: LlmProvider): LlmProvider {
  return typeof value === "string" && (PROVIDERS as string[]).includes(value)
    ? (value as LlmProvider)
    : fallback;
}

function normalizeModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function toSettings(row: SettingsRow | null): OwnerSettings {
  if (!row) return DEFAULTS;
  return {
    stackPolicy: row.stack_policy,
    planModeDefault: row.plan_mode_default,
    llmProvider: normalizeProvider(row.llm_provider, DEFAULTS.llmProvider),
    llmModel: normalizeModel(row.llm_model, DEFAULTS.llmModel),
  };
}

/** Load the owner's chat settings, or platform defaults if none saved yet. */
export async function loadOwnerSettings(email: string): Promise<OwnerSettings> {
  const row = await one<SettingsRow>(
    "SELECT stack_policy, plan_mode_default, llm_provider, llm_model FROM owner_settings WHERE owner_email = $1",
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

  app.put<{
    Body: {
      stackPolicy?: string;
      planModeDefault?: boolean;
      llmProvider?: string;
      llmModel?: string;
    };
  }>(
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
      const llmProvider = normalizeProvider(req.body?.llmProvider, current.llmProvider);
      const llmModel = normalizeModel(req.body?.llmModel, current.llmModel);

      await query(
        `INSERT INTO owner_settings (owner_email, stack_policy, plan_mode_default, llm_provider, llm_model, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (owner_email) DO UPDATE SET
           stack_policy = EXCLUDED.stack_policy,
           plan_mode_default = EXCLUDED.plan_mode_default,
           llm_provider = EXCLUDED.llm_provider,
           llm_model = EXCLUDED.llm_model,
           updated_at = now()`,
        [actor.email, stackPolicy, planModeDefault, llmProvider, llmModel]
      );
      await audit({ actorEmail: actor.email, action: "settings.update" });

      return reply.send({ settings: { stackPolicy, planModeDefault, llmProvider, llmModel } });
    }
  );
}
