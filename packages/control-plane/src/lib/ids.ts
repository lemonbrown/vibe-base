import { randomBytes, randomUUID } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, url-safe, base36 id with a prefix, e.g. "dep_8f3k1a9z". */
export function shortId(prefix: string, len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Opaque high-entropy token (sessions, invites, generated passwords). */
export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export { randomUUID };
