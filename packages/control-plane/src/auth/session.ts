import { scrypt as _scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { loadConfig } from "../config.js";
import { one, query } from "../db.js";
import { token } from "../lib/ids.js";

const scrypt = promisify(_scrypt);

const SESSION_COOKIE = "vibe_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface Actor {
  email: string;
  role: string;
  /** true when authenticated via the owner CLI bearer token. */
  viaToken: boolean;
}

/* --------------------------- password hashing -------------------------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------ sessions ------------------------------- */

export async function createSession(email: string): Promise<string> {
  const id = token(32);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    "INSERT INTO sessions (id, email, expires_at) VALUES ($1, $2, $3)",
    [id, email, expires]
  );
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await query("DELETE FROM sessions WHERE id = $1", [id]);
}

interface SessionRow {
  email: string;
  role: string;
}

async function actorFromSession(sessionId: string): Promise<Actor | null> {
  const row = await one<SessionRow>(
    `SELECT s.email, u.role
       FROM sessions s
       JOIN users u ON u.email = s.email
      WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [sessionId]
  );
  return row ? { email: row.email, role: row.role, viaToken: false } : null;
}

/** Resolve the acting principal: CLI bearer (owner) or browser session. */
export async function getActor(req: FastifyRequest): Promise<Actor | null> {
  const cfg = loadConfig();
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const presented = Buffer.from(auth.slice(7));
    const expected = Buffer.from(cfg.ownerToken);
    if (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      return { email: cfg.ownerEmail, role: "owner", viaToken: true };
    }
    return null;
  }

  const sessionId = (req as FastifyRequest & { cookies?: Record<string, string> })
    .cookies?.[SESSION_COOKIE];
  if (sessionId) return actorFromSession(sessionId);
  return null;
}

export function isOwner(actor: Actor | null): boolean {
  return !!actor && actor.role === "owner";
}

export { SESSION_COOKIE };
