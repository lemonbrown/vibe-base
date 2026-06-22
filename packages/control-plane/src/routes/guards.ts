import type { FastifyReply, FastifyRequest } from "fastify";
import { getActor, isOwner, type Actor } from "../auth/session.js";

/** Require the owner. Sends 401/403 and returns null if not authorized. */
export async function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<Actor | null> {
  const actor = await getActor(req);
  if (!actor) {
    reply.code(401).send({ error: "authentication required" });
    return null;
  }
  if (!isOwner(actor)) {
    reply.code(403).send({ error: "owner only" });
    return null;
  }
  return actor;
}

/** Require any authenticated user (owner or member). */
export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<Actor | null> {
  const actor = await getActor(req);
  if (!actor) {
    reply.code(401).send({ error: "authentication required" });
    return null;
  }
  return actor;
}
