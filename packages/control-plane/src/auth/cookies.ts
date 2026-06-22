import type { FastifyReply } from "fastify";
import { loadConfig } from "../config.js";
import { SESSION_COOKIE } from "./session.js";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  const cfg = loadConfig();
  reply.setCookie(SESSION_COOKIE, sessionId, {
    domain: cfg.cookieDomain,
    path: "/",
    httpOnly: true,
    secure: !cfg.insecureCookies,
    sameSite: "lax",
    maxAge: THIRTY_DAYS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const cfg = loadConfig();
  reply.clearCookie(SESSION_COOKIE, { domain: cfg.cookieDomain, path: "/" });
}
