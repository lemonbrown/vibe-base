import { query } from "../db.js";
import { shortId } from "./ids.js";

export type ActorKind = "user" | "llm" | "system";

export interface AuditInput {
  actorEmail?: string | null;
  actorKind?: ActorKind;
  action: string;
  appId?: string | null;
  detail?: Record<string, unknown>;
  success?: boolean;
}

/** Record a platform action per spec §23.4. Never throws into the caller. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_events (id, actor_email, actor_kind, action, app_id, detail, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        shortId("evt"),
        input.actorEmail ?? null,
        input.actorKind ?? "user",
        input.action,
        input.appId ?? null,
        JSON.stringify(input.detail ?? {}),
        input.success ?? true,
      ]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record event", input.action, err);
  }
}
