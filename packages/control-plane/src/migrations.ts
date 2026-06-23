import { getPool } from "./db.js";

interface Migration {
  id: string;
  sql: string;
}

/**
 * Forward-only migrations. Each runs once, recorded in schema_migrations.
 * Keep them additive; the MVP never auto-drops platform tables.
 */
const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS apps (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        visibility            TEXT NOT NULL DEFAULT 'private',
        access_mode           TEXT NOT NULL DEFAULT 'invite-only',
        default_role          TEXT NOT NULL DEFAULT 'member',
        subdomain             TEXT NOT NULL UNIQUE,
        manifest              JSONB NOT NULL,
        status                TEXT NOT NULL DEFAULT 'registered',
        current_deployment_id TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id                TEXT PRIMARY KEY,
        app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'queued',
        image_tag         TEXT,
        container_name    TEXT,
        port              INTEGER,
        health            TEXT NOT NULL DEFAULT 'unknown',
        error             TEXT,
        build_log         TEXT NOT NULL DEFAULT '',
        rollback_target   TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS deployments_app_idx ON deployments(app_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS db_provisions (
        app_id      TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        db_name     TEXT NOT NULL,
        db_user     TEXT NOT NULL,
        db_password TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS storage_provisions (
        app_id     TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        bucket     TEXT NOT NULL,
        prefix     TEXT NOT NULL,
        access_key TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS env_vars (
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        key    TEXT NOT NULL,
        value  TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        PRIMARY KEY (app_id, key)
      );

      CREATE TABLE IF NOT EXISTS users (
        email         TEXT PRIMARY KEY,
        role          TEXT NOT NULL DEFAULT 'member',
        password_hash TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS app_members (
        app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'member',
        status     TEXT NOT NULL DEFAULT 'invited',
        invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (app_id, email)
      );

      CREATE TABLE IF NOT EXISTS invites (
        token      TEXT PRIMARY KEY,
        app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id          TEXT PRIMARY KEY,
        actor_email TEXT,
        actor_kind  TEXT NOT NULL DEFAULT 'user',
        action      TEXT NOT NULL,
        app_id      TEXT,
        detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
        success     BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0002_deploy_source",
    sql: `
      ALTER TABLE deployments ADD COLUMN IF NOT EXISTS source  TEXT NOT NULL DEFAULT 'context';
      ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_sha TEXT;
      ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_ref TEXT;
    `,
  },
  {
    id: "0003_app_repos",
    sql: `
      CREATE TABLE IF NOT EXISTS app_repos (
        app_id         TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        provider       TEXT NOT NULL DEFAULT 'github',
        repo_full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        html_url       TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // The chat relay: portal conversations turn into jobs that a daemon on the
    // owner's machine claims and runs `claude` for, streaming events back.
    id: "0004_chat_relay",
    sql: `
      CREATE TABLE IF NOT EXISTS machines (
        id           TEXT PRIMARY KEY,
        owner_email  TEXT NOT NULL,
        name         TEXT NOT NULL,
        last_seen_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id                TEXT PRIMARY KEY,
        owner_email       TEXT NOT NULL,
        title             TEXT NOT NULL DEFAULT 'New chat',
        target_app        TEXT,
        claude_session_id TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS conversations_owner_idx
        ON conversations(owner_email, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'done',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conv_id, created_at);

      CREATE TABLE IF NOT EXISTS jobs (
        id                TEXT PRIMARY KEY,
        conv_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id        TEXT,
        machine_id        TEXT,
        kind              TEXT NOT NULL DEFAULT 'ask',
        target_app        TEXT,
        instruction       TEXT NOT NULL,
        claude_session_id TEXT,
        status            TEXT NOT NULL DEFAULT 'queued',
        error             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS job_events (
        id         BIGSERIAL PRIMARY KEY,
        job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, seq);
    `,
  },
  {
    // Per-owner chat settings: a free-text stack policy injected into build/
    // adjust jobs, and a default for plan mode. Jobs snapshot both at send time
    // so editing settings later never rewrites in-flight work.
    id: "0005_owner_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS owner_settings (
        owner_email       TEXT PRIMARY KEY,
        stack_policy      TEXT NOT NULL DEFAULT '',
        plan_mode_default BOOLEAN NOT NULL DEFAULT false,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS plan_mode    BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stack_policy TEXT;
    `,
  },
  {
    // Provider/model selection for the local LLM runner. The existing
    // claude_session_id column remains as the provider session id for backwards
    // compatibility; llm_provider gates whether it is safe to resume.
    id: "0006_llm_provider_model",
    sql: `
      ALTER TABLE owner_settings ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'claude';
      ALTER TABLE owner_settings ADD COLUMN IF NOT EXISTS llm_model    TEXT NOT NULL DEFAULT 'sonnet';

      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'claude';

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'claude';
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS llm_model    TEXT NOT NULL DEFAULT 'sonnet';
    `,
  },
  {
    id: "0007_reasoning_effort",
    sql: `
      ALTER TABLE owner_settings ADD COLUMN IF NOT EXISTS llm_reasoning_effort TEXT DEFAULT NULL;
      ALTER TABLE jobs           ADD COLUMN IF NOT EXISTS llm_reasoning_effort TEXT DEFAULT NULL;
    `,
  },
  {
    // Allow system-triggered verify jobs that have no portal conversation.
    // owner_email tracks whose settings/queue to use when creating follow-up adjust jobs.
    id: "0008_verify_jobs",
    sql: `
      ALTER TABLE jobs ALTER COLUMN conv_id DROP NOT NULL;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_email TEXT;
    `,
  },
];

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (const m of MIGRATIONS) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [m.id]
    );
    if (rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
        m.id,
      ]);
      await client.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${m.id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
