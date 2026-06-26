import type { AppEnvironment } from "@vibe/shared";
import { loadConfig } from "../config.js";

/**
 * Programs Caddy entirely through its admin API — no Caddyfile, no manual
 * edits (spec §13.3). Each app becomes a route that:
 *   1. forward-auths every request to the control plane (/authz)
 *   2. on 2xx, copies X-Vibe-User-* onto the request and proxies to the app
 *   3. on non-2xx (e.g. 302 to login), returns the auth response to the client
 */

const ROUTE_ID = (appId: string, environment: AppEnvironment = "prod") =>
  environment === "prod" ? `app-${appId}` : `app-${appId}-${environment}`;

async function admin(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const cfg = loadConfig();
  // Caddy's admin API rejects state-changing requests whose Origin isn't in
  // its allowlist. Node's fetch sends an empty Origin (unlike curl, which
  // sends none), so we set it explicitly to the admin endpoint's own origin —
  // which must also appear in `admin.origins` in infra/caddy.json.
  const headers: Record<string, string> = { Origin: cfg.caddyAdmin };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${cfg.caddyAdmin}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

function controlPlaneRoute(): unknown {
  const cfg = loadConfig();
  return {
    "@id": "control-plane",
    match: [{ host: [cfg.controlPlaneDomain] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: cfg.cpUpstream }],
      },
    ],
  };
}

function appRoute(
  subdomain: string,
  container: string,
  port: number,
  appId: string,
  environment: AppEnvironment = "prod"
): unknown {
  const cfg = loadConfig();
  const host = `${subdomain}.${cfg.appsDomain}`;
  return {
    "@id": ROUTE_ID(appId, environment),
    match: [{ host: [host] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            // Step 1: forward-auth to the control plane.
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: cfg.cpUpstream }],
                rewrite: { method: "GET", uri: "/authz" },
                headers: {
                  request: {
                    set: {
                      "X-Vibe-App-Host": ["{http.request.host}"],
                      "X-Forwarded-Uri": ["{http.request.uri}"],
                    },
                  },
                },
                // On 2xx: copy identity onto the request and fall through to
                // the next handler (the real app). On non-2xx, Caddy returns
                // the auth response (redirect to login / 403) to the client.
                handle_response: [
                  {
                    match: { status_code: [2] },
                    routes: [
                      {
                        handle: [
                          {
                            handler: "headers",
                            request: {
                              set: {
                                "X-Vibe-User-Email": [
                                  "{http.reverse_proxy.header.X-Vibe-User-Email}",
                                ],
                                "X-Vibe-User-Role": [
                                  "{http.reverse_proxy.header.X-Vibe-User-Role}",
                                ],
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            // Step 2: proxy to the app container.
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: `${container}:${port}` }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Create srv0 + on-demand TLS + the control-plane route, if not present.
 * Uses targeted PUTs so the admin/listen config (from caddy.json) is never
 * clobbered. Assumes apps.http.servers already exists (see caddy.json).
 */
export async function ensureBaseConfig(): Promise<void> {
  const cfg = loadConfig();
  const current = await admin("GET", "/config/apps/http/servers/srv0");
  if (current.ok) {
    const json = (await current.json()) as unknown;
    if (json) return; // already initialized
  }

  const srv0 = await admin("PUT", "/config/apps/http/servers/srv0", {
    listen: [":443"],
    routes: [controlPlaneRoute()],
  });
  if (!srv0.ok) {
    throw new Error(`caddy srv0 init failed: ${srv0.status} ${await srv0.text()}`);
  }

  // Local dev: self-signed certs via Caddy's internal CA for every managed
  // host (route hostnames get a cert automatically when the route is added).
  // Production: real certs via ACME, issued on-demand and gated by /tls-check.
  const tls =
    cfg.tlsMode === "internal"
      ? { automation: { policies: [{ issuers: [{ module: "internal" }] }] } }
      : {
          automation: {
            on_demand: {
              permission: {
                module: "http",
                endpoint: `http://${cfg.cpUpstream}/tls-check`,
              },
            },
          },
        };
  await admin("PUT", "/config/apps/tls", tls);
}

/** Add or replace the route for an app, pointing at a live container. */
export async function upsertAppRoute(
  appId: string,
  subdomain: string,
  container: string,
  port: number,
  environment: AppEnvironment = "prod"
): Promise<void> {
  const route = appRoute(subdomain, container, port, appId, environment);
  const existing = await admin("GET", `/id/${ROUTE_ID(appId, environment)}`);
  if (existing.ok) {
    const res = await admin("PATCH", `/id/${ROUTE_ID(appId, environment)}`, route);
    if (!res.ok) throw new Error(`caddy route update failed: ${await res.text()}`);
  } else {
    const res = await admin(
      "POST",
      "/config/apps/http/servers/srv0/routes",
      route
    );
    if (!res.ok) throw new Error(`caddy route create failed: ${await res.text()}`);
  }
}

export async function removeAppRoute(
  appId: string,
  environment: AppEnvironment = "prod"
): Promise<void> {
  await admin("DELETE", `/id/${ROUTE_ID(appId, environment)}`);
}
