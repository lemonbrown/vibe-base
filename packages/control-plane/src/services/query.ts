import pg from "pg";
import type {
  PlatformAppDetail,
  PlatformAppLine,
  PlatformOverview,
  ReadModelInfo,
  ReadModelResult,
  SecretPresence,
} from "@vibe/shared";
import { bindParams, validateReadModelSql } from "@vibe/shared";
import type { Actor } from "../auth/session.js";
import { isOwner } from "../auth/session.js";
import { one, query } from "../db.js";
import {
  appSummary,
  deploymentToContract,
  getApp,
  getAppRepo,
  listApps,
  recentDeployments,
  type AppRow,
} from "../repo.js";
import { databaseUrlFor, isDatabaseProvisioned } from "./dbProvision.js";
import { isStorageProvisioned } from "./storage.js";

/** Max rows a single read-model query may return to an LLM. */
const MAX_ROWS = 1000;
/** Per-query statement timeout for read-models (ms). */
const QUERY_TIMEOUT_MS = 5000;

/* --------------------------- access scoping --------------------------- */

/**
 * The set of app ids an actor may see. The owner sees everything; any other
 * principal sees only apps they are an active member of. This is the single
 * choke point every query path runs through.
 */
async function accessibleAppIds(actor: Actor): Promise<Set<string> | "all"> {
  if (isOwner(actor)) return "all";
  const res = await query<{ app_id: string }>(
    "SELECT app_id FROM app_members WHERE email = $1 AND status = 'active'",
    [actor.email]
  );
  return new Set(res.rows.map((r) => r.app_id));
}

function canSee(scope: Set<string> | "all", appId: string): boolean {
  return scope === "all" || scope.has(appId);
}

/** Throws a 403-ish error if the actor cannot see the app. */
export class AccessError extends Error {}
export class NotFoundError extends Error {}

/* ----------------------------- Stratum 1 ------------------------------ */

async function appLine(row: AppRow): Promise<PlatformAppLine> {
  const summary = await appSummary(row);
  const members = await one<{ n: string }>(
    "SELECT count(*)::text AS n FROM app_members WHERE app_id = $1 AND status = 'active'",
    [row.id]
  );
  return {
    id: summary.id,
    name: summary.name,
    status: summary.status,
    health: summary.health,
    url: summary.url,
    visibility: summary.visibility,
    lastDeployedAt: summary.lastDeployedAt,
    members: Number(members?.n ?? "0"),
    readModels: row.manifest.readModels?.length ?? 0,
    database: !!row.manifest.capabilities.database,
    storage: !!row.manifest.capabilities.storage,
  };
}

export async function platformOverview(actor: Actor): Promise<PlatformOverview> {
  const scope = await accessibleAppIds(actor);
  const rows = (await listApps()).filter((r) => canSee(scope, r.id));
  const apps = await Promise.all(rows.map(appLine));
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      apps: apps.length,
      live: apps.filter((a) => a.status === "live").length,
      unhealthy: apps.filter((a) => a.health === "unhealthy").length,
    },
    apps,
  };
}

/** Names-only view of an app's env vars — never the values (spec §23.1). */
async function secretPresence(appId: string): Promise<SecretPresence> {
  const res = await query<{ key: string; source: string }>(
    "SELECT key, source FROM env_vars WHERE app_id = $1 ORDER BY key",
    [appId]
  );
  const out: SecretPresence = {};
  for (const r of res.rows) out[r.key] = { present: true, type: r.source };
  return out;
}

function readModelInfo(row: AppRow): ReadModelInfo[] {
  return (row.manifest.readModels ?? []).map((m) => ({
    name: m.name,
    description: m.description,
    params: m.params.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: p.required,
    })),
  }));
}

export async function appDetail(
  actor: Actor,
  appId: string
): Promise<PlatformAppDetail> {
  const scope = await accessibleAppIds(actor);
  const row = await getApp(appId);
  if (!row) throw new NotFoundError("app not found");
  if (!canSee(scope, appId)) throw new AccessError("not a member of this app");

  const m = row.manifest;
  const members = await query<{ email: string; role: string; status: string }>(
    "SELECT email, role, status FROM app_members WHERE app_id = $1 ORDER BY role, email",
    [appId]
  );
  const deps = await recentDeployments(appId, 5);
  const repo = await getAppRepo(appId);

  return {
    app: await appSummary(row),
    description: m.description,
    manifestSummary: {
      runtimeAdapter: m.runtime.adapter,
      port: m.runtime.port,
      healthPath: m.runtime.healthPath,
      capabilities: m.capabilities as unknown as Record<string, boolean>,
    },
    access: {
      mode: m.access.mode,
      defaultRole: m.access.defaultRole,
      visibility: m.visibility,
      roles: m.roles,
    },
    database: {
      enabled: m.capabilities.database,
      provisioned: await isDatabaseProvisioned(appId),
    },
    storage: {
      enabled: m.capabilities.storage,
      provisioned: await isStorageProvisioned(appId),
    },
    members: members.rows,
    recentDeployments: deps.map(deploymentToContract),
    repo: repo
      ? {
          repoFullName: repo.repo_full_name,
          defaultBranch: repo.default_branch,
          htmlUrl: repo.html_url,
        }
      : null,
    secrets: await secretPresence(appId),
    readModels: readModelInfo(row),
  };
}

export interface AuditLine {
  id: string;
  actorEmail: string | null;
  actorKind: string;
  action: string;
  appId: string | null;
  detail: Record<string, unknown>;
  success: boolean;
  createdAt: string;
}

export async function listAuditEvents(
  actor: Actor,
  opts: { appId?: string; action?: string; limit?: number } = {}
): Promise<AuditLine[]> {
  const scope = await accessibleAppIds(actor);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.appId) {
    params.push(opts.appId);
    where.push(`app_id = $${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  // Members only ever see events for their own apps (and never global ones).
  if (scope !== "all") {
    const ids = [...scope];
    if (ids.length === 0) return [];
    params.push(ids);
    where.push(`app_id = ANY($${params.length})`);
  }
  params.push(limit);
  const sql = `SELECT id, actor_email, actor_kind, action, app_id, detail, success, created_at
                 FROM audit_events
                ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY created_at DESC
                LIMIT $${params.length}`;
  const res = await query<{
    id: string;
    actor_email: string | null;
    actor_kind: string;
    action: string;
    app_id: string | null;
    detail: Record<string, unknown>;
    success: boolean;
    created_at: Date;
  }>(sql, params);
  return res.rows.map((r) => ({
    id: r.id,
    actorEmail: r.actor_email,
    actorKind: r.actor_kind,
    action: r.action,
    appId: r.app_id,
    detail: r.detail,
    success: r.success,
    createdAt: r.created_at.toISOString(),
  }));
}

/* ----------------------------- Stratum 2 ------------------------------ */
/** Cached read-only connection pools to each app's own database. */
const appPools = new Map<string, { url: string; pool: pg.Pool }>();

async function appPool(appId: string): Promise<pg.Pool> {
  const url = await databaseUrlFor(appId);
  if (!url) throw new NotFoundError("this app has no provisioned database");
  const cached = appPools.get(appId);
  if (cached && cached.url === url) return cached.pool;
  if (cached) await cached.pool.end().catch(() => {});
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  appPools.set(appId, { url, pool });
  return pool;
}

export async function listReadModels(
  actor: Actor,
  appId: string
): Promise<ReadModelInfo[]> {
  const scope = await accessibleAppIds(actor);
  const row = await getApp(appId);
  if (!row) throw new NotFoundError("app not found");
  if (!canSee(scope, appId)) throw new AccessError("not a member of this app");
  return readModelInfo(row);
}

/**
 * Run a declared read-model against the app's own database. Enforced read-only:
 * the query runs inside a READ ONLY transaction with a statement timeout, so
 * even though the connection role can write, the query physically cannot.
 */
export async function runReadModel(
  actor: Actor,
  appId: string,
  modelName: string,
  params: Record<string, unknown> = {}
): Promise<ReadModelResult> {
  const scope = await accessibleAppIds(actor);
  const row = await getApp(appId);
  if (!row) throw new NotFoundError("app not found");
  if (!canSee(scope, appId)) throw new AccessError("not a member of this app");

  const model = (row.manifest.readModels ?? []).find((m) => m.name === modelName);
  if (!model) throw new NotFoundError(`no read-model named "${modelName}"`);

  // Defence in depth: re-validate the stored SQL before executing it.
  const sqlErr = validateReadModelSql(model.sql);
  if (sqlErr) throw new Error(`read-model "${modelName}" is invalid: ${sqlErr}`);

  const values = bindParams(model, params);
  const pool = await appPool(appId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const res = await client.query({ text: model.sql, values: values as never[] });
    const truncated = res.rows.length > MAX_ROWS;
    const rows = truncated ? res.rows.slice(0, MAX_ROWS) : res.rows;
    return {
      app: appId,
      model: modelName,
      columns: res.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Drop a cached app pool (call from teardown when an app is deleted). */
export async function closeAppPool(appId: string): Promise<void> {
  const cached = appPools.get(appId);
  if (cached) {
    appPools.delete(appId);
    await cached.pool.end().catch(() => {});
  }
}
