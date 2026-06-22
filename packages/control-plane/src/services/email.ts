import { loadConfig } from "../config.js";

/**
 * Platform email (spec §17, MVP): a single shared SMTP sender configured on the
 * control plane. Apps that declare `capabilities.email` receive SMTP_* env and
 * send with any standard SMTP client (e.g. nodemailer). No per-app provisioning
 * — the sender is shared, so this is just env injection (cf. services/storage).
 */

export function emailConfigured(): boolean {
  const { smtp } = loadConfig();
  return Boolean(smtp.host && smtp.user && smtp.from);
}

/** SMTP env vars injected into an app container when email is enabled. */
export function emailEnvFor(): Record<string, string> | null {
  const { smtp } = loadConfig();
  if (!emailConfigured()) return null;
  return {
    SMTP_HOST: smtp.host,
    SMTP_PORT: String(smtp.port),
    SMTP_USER: smtp.user,
    SMTP_PASS: smtp.pass,
    SMTP_FROM: smtp.from,
    SMTP_SECURE: smtp.secure ? "true" : "false",
  };
}
