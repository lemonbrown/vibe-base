import { loadConfig } from "./config.js";
import { query } from "./db.js";
import { hashPassword } from "./auth/session.js";

/**
 * Ensure the owner account exists. The owner can log into the browser
 * (portal + apps) with OWNER_PASSWORD, or — if unset — with OWNER_TOKEN,
 * so a fresh install has exactly one working credential out of the box.
 */
export async function ensureOwner(): Promise<void> {
  const cfg = loadConfig();
  const existing = await query("SELECT password_hash FROM users WHERE email = $1", [
    cfg.ownerEmail,
  ]);
  if (existing.rowCount && existing.rows[0]!.password_hash) return;

  // Use `||` not `??`: compose passes an unset OWNER_PASSWORD as "" (empty
  // string), which `??` would not treat as missing.
  const password = process.env.OWNER_PASSWORD || cfg.ownerToken;
  const hash = await hashPassword(password);
  await query(
    `INSERT INTO users (email, role, password_hash, status)
     VALUES ($1, 'owner', $2, 'active')
     ON CONFLICT (email) DO UPDATE SET role = 'owner', password_hash = EXCLUDED.password_hash, status = 'active'`,
    [cfg.ownerEmail, hash]
  );
}
