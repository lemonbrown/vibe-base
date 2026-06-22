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
  /** Container registry the VPS pulls app images from (ghcr.io). */
  registry: {
    host: string;
    username: string;
    /** Token with read:packages; empty disables `docker login` (public images only). */
    token: string;
  };
  /** GitHub integration. Empty token disables repo creation + deployment status. */
  github: {
    token: string;
    apiBase: string;
    /** Default owner (login) new repos are created under. Empty = the token's user. */
    owner: string;
    /** When true, create repos under the org `owner`; otherwise under /user. */
    ownerIsOrg: boolean;
  };
  /** Platform SMTP for app email. Empty host means email is not configured. */
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    /** Shared sender address all apps send from (e.g. you@gmail.com). */
    from: string;
    /** true for implicit TLS (port 465); false for STARTTLS (port 587). */
    secure: boolean;
  };
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
    registry: {
      host: opt("REGISTRY_HOST", "ghcr.io"),
      username: opt("GHCR_USERNAME", ""),
      token: opt("GHCR_TOKEN", ""),
    },
    github: {
      token: opt("GITHUB_TOKEN", ""),
      apiBase: opt("GITHUB_API_BASE", "https://api.github.com"),
      owner: opt("GITHUB_DEFAULT_OWNER", ""),
      ownerIsOrg: opt("GITHUB_OWNER_IS_ORG", "false") === "true",
    },
    smtp: {
      host: opt("SMTP_HOST", ""),
      port: Number(opt("SMTP_PORT", "587")),
      user: opt("SMTP_USER", ""),
      pass: opt("SMTP_PASS", ""),
      from: opt("SMTP_FROM", ""),
      secure: opt("SMTP_SECURE", "false") === "true",
    },
  };
  return cached;
}
