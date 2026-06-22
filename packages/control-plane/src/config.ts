/** Central runtime configuration, read once from the environment. */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  /** Port the control-plane API listens on. */
  port: number;
  /** Platform Postgres connection (must be able to CREATE DATABASE/ROLE). */
  databaseUrl: string;
  /** Wildcard domain apps are served under, e.g. "apps.example.com". */
  appsDomain: string;
  /** Host the portal + login + forward-auth are served on. */
  controlPlaneDomain: string;
  /** The single platform owner. */
  ownerEmail: string;
  /** Bearer token the CLI uses to authenticate as owner. */
  ownerToken: string;
  /** Secret used to sign session cookies. */
  sessionSecret: string;
  /** Caddy admin API base, e.g. "http://localhost:2019". */
  caddyAdmin: string;
  /** TLS issuance: "acme" (real certs) or "internal" (self-signed, local dev). */
  tlsMode: string;
  /** How Caddy reaches the control plane on the docker network. */
  cpUpstream: string;
  /** Cookie Domain so the session is shared across apps + portal subdomains. */
  cookieDomain: string;
  /** Docker network shared by control-plane, postgres, and app containers. */
  dockerNetwork: string;
  /** Hostname app containers use to reach the platform Postgres. */
  pgHostForApps: string;
  /** Working directory for build contexts, dumps, temp files. */
  dataDir: string;
  /** MinIO/S3 settings for storage provisioning. */
  storage: {
    endpoint: string;
    publicEndpoint: string;
    rootUser: string;
    rootPassword: string;
    region: string;
  };
  /** When true, skip TLS-only cookie flag (local dev over http). */
  insecureCookies: boolean;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    port: Number(opt("PORT", "8080")),
    databaseUrl: req("DATABASE_URL"),
    appsDomain: req("APPS_DOMAIN"),
    controlPlaneDomain: opt("CONTROL_PLANE_DOMAIN", req("APPS_DOMAIN")),
    ownerEmail: req("OWNER_EMAIL"),
    ownerToken: req("OWNER_TOKEN"),
    sessionSecret: req("SESSION_SECRET"),
    caddyAdmin: opt("CADDY_ADMIN", "http://localhost:2019"),
    tlsMode: opt("TLS_MODE", "acme"),
    cpUpstream: opt("CP_UPSTREAM", "control-plane:8080"),
    cookieDomain: opt("COOKIE_DOMAIN", `.${req("APPS_DOMAIN")}`),
    dockerNetwork: opt("DOCKER_NETWORK", "vibe"),
    pgHostForApps: opt("PG_HOST_FOR_APPS", "postgres"),
    dataDir: opt("DATA_DIR", "/var/lib/vibe"),
    storage: {
      endpoint: opt("MINIO_ENDPOINT", "http://minio:9000"),
      publicEndpoint: opt("MINIO_PUBLIC_ENDPOINT", "http://localhost:9000"),
      rootUser: opt("MINIO_ROOT_USER", "vibe"),
      rootPassword: opt("MINIO_ROOT_PASSWORD", "vibe-secret"),
      region: opt("MINIO_REGION", "us-east-1"),
    },
    insecureCookies: opt("INSECURE_COOKIES", "false") === "true",
  };
  return cached;
}
