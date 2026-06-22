import { loadConfig } from "../config.js";
import { getPool, one, query } from "../db.js";
import { randomBytes } from "node:crypto";

interface DbProvisionRow {
  app_id: string;
  db_name: string;
  db_user: string;
  db_password: string;
}

/** Map an app id to a safe Postgres identifier. */
function ident(appId: string): string {
  const safe = appId.replace(/[^a-z0-9_]/g, "_");
  return `app_${safe}`.slice(0, 60);
}

function buildUrl(row: DbProvisionRow): string {
  const cfg = loadConfig();
  return `postgres://${row.db_user}:${row.db_password}@${cfg.pgHostForApps}:5432/${row.db_name}`;
}

/**
 * Ensure a dedicated database + login role exists for the app.
 * Idempotent: returns the existing DATABASE_URL if already provisioned.
 * Uses the platform admin connection, which must have CREATEDB/CREATEROLE.
 */
export async function provisionDatabase(appId: string): Promise<string> {
  const existing = await one<DbProvisionRow>(
    "SELECT * FROM db_provisions WHERE app_id = $1",
    [appId]
  );
  if (existing) return buildUrl(existing);

  const name = ident(appId);
  const user = name;
  const password = randomBytes(18).toString("hex");
  const pool = getPool();

  // CREATE ROLE/DATABASE cannot run inside a transaction block.
  const roleExists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    user,
  ]);
  if (!roleExists.rowCount) {
    await pool.query(`CREATE ROLE "${user}" LOGIN PASSWORD '${password}'`);
  } else {
    await pool.query(`ALTER ROLE "${user}" LOGIN PASSWORD '${password}'`);
  }

  const dbExists = await pool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [name]
  );
  if (!dbExists.rowCount) {
    await pool.query(`CREATE DATABASE "${name}" OWNER "${user}"`);
  }

  const row: DbProvisionRow = {
    app_id: appId,
    db_name: name,
    db_user: user,
    db_password: password,
  };
  await query(
    `INSERT INTO db_provisions (app_id, db_name, db_user, db_password)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (app_id) DO UPDATE SET db_password = EXCLUDED.db_password`,
    [row.app_id, row.db_name, row.db_user, row.db_password]
  );
  return buildUrl(row);
}

export async function databaseUrlFor(appId: string): Promise<string | null> {
  const row = await one<DbProvisionRow>(
    "SELECT * FROM db_provisions WHERE app_id = $1",
    [appId]
  );
  return row ? buildUrl(row) : null;
}

export async function isDatabaseProvisioned(appId: string): Promise<boolean> {
  const res = await query("SELECT 1 FROM db_provisions WHERE app_id = $1", [appId]);
  return !!res.rowCount;
}

/**
 * Tear down the app's dedicated database and login role on the VPS, then drop
 * the provisioning record. Idempotent: a no-op when nothing was provisioned.
 * DROP DATABASE/ROLE cannot run inside a transaction, so we use the raw pool.
 * Best-effort on the SQL side — a failure to drop must not strand the rest of
 * the teardown — but the record is only removed once the database is gone.
 */
export async function deprovisionDatabase(appId: string): Promise<void> {
  const row = await one<DbProvisionRow>(
    "SELECT * FROM db_provisions WHERE app_id = $1",
    [appId]
  );
  if (!row) return;
  const pool = getPool();

  // Kick off any open sessions so DROP DATABASE isn't blocked by connections.
  await pool
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [row.db_name]
    )
    .catch(() => {});

  // Identifiers are derived from ident()/the role name (sanitized to
  // [a-z0-9_]), so they are safe to interpolate here.
  await pool.query(`DROP DATABASE IF EXISTS "${row.db_name}"`);
  // The role can only be dropped once it owns nothing — which holds now that
  // its single database is gone.
  await pool.query(`DROP ROLE IF EXISTS "${row.db_user}"`).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[deprovision] could not drop role ${row.db_user}`, err);
  });

  await query("DELETE FROM db_provisions WHERE app_id = $1", [appId]);
}
