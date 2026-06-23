import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { getActor, isOwner } from "../auth/session.js";

/**
 * Serve the owner portal — a Vite/React SPA (packages/portal) — behind the same
 * owner session the rest of the platform uses. Hashed assets are served openly
 * (they hold no secrets); every SPA navigation is gated and falls back to
 * index.html so client-side routing works. All data comes from the `/api/*`
 * JSON layer the SPA calls with the session cookie.
 */
export async function portalRoutes(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/routes
  const distDir =
    process.env.PORTAL_DIST ?? resolve(here, "../../../portal/dist");

  if (!existsSync(resolve(distDir, "index.html"))) {
    app.log.warn(
      `[portal] SPA not found at ${distDir} — build packages/portal (bun run build) ` +
        `or set PORTAL_DIST. Portal UI is disabled until then.`
    );
    return;
  }

  // wildcard:false registers a route per built file (assets, favicon, …) and,
  // crucially, NO greedy catch-all — so SPA paths fall through to the
  // not-found handler below where we gate + serve index.html.
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: "/",
    index: false,
    wildcard: false,
  });

  app.setNotFoundHandler(async (req, reply) => {
    // Anything that isn't a GET for an app/page belongs to the API surface.
    const isPageGet =
      (req.method === "GET" || req.method === "HEAD") &&
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/authz") &&
      !req.url.startsWith("/tls-check");
    if (!isPageGet) {
      return reply.code(404).send({ error: "not found" });
    }

    const actor = await getActor(req);
    if (!isOwner(actor)) {
      const cfg = loadConfig();
      const next = `https://${cfg.controlPlaneDomain}${req.url}`;
      return reply.redirect(
        `https://${cfg.controlPlaneDomain}/login?next=${encodeURIComponent(next)}`
      );
    }
    return reply.sendFile("index.html");
  });
}
