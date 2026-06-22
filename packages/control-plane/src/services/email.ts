import { loadConfig } from "../config.js";

/**
 * Platform email (spec §17, MVP): a single shared sender configured on the
 * control plane. Apps that declare `capabilities.email` receive email env and
 * send themselves — no per-app provisioning (cf. services/storage).
 *
 * Two transports are supported, selected by what's configured:
 *  - "gmail-api": Gmail API over HTTPS (OAuth2). Works where outbound SMTP is
 *    blocked (e.g. DigitalOcean). Preferred when its creds are present.
 *  - "smtp": plain SMTP (nodemailer). Simple, but needs ports 465/587 open.
 * Apps branch on the injected EMAIL_PROVIDER var.
 */

export type EmailProvider = "gmail-api" | "smtp";

export function emailProvider(): EmailProvider | null {
  const { gmail, smtp } = loadConfig();
  if (gmail.clientId && gmail.clientSecret && gmail.refreshToken && (gmail.from || smtp.from)) {
    return "gmail-api";
  }
  if (smtp.host && smtp.user && smtp.from) return "smtp";
  return null;
}

export function emailConfigured(): boolean {
  return emailProvider() !== null;
}

/** Email env vars injected into an app container when email is enabled. */
export function emailEnvFor(): Record<string, string> | null {
  const { gmail, smtp } = loadConfig();
  const provider = emailProvider();
  if (!provider) return null;

  if (provider === "gmail-api") {
    const from = gmail.from || smtp.from;
    return {
      EMAIL_PROVIDER: "gmail-api",
      EMAIL_FROM: from,
      GMAIL_CLIENT_ID: gmail.clientId,
      GMAIL_CLIENT_SECRET: gmail.clientSecret,
      GMAIL_REFRESH_TOKEN: gmail.refreshToken,
      GMAIL_FROM: from,
    };
  }

  return {
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM: smtp.from,
    SMTP_HOST: smtp.host,
    SMTP_PORT: String(smtp.port),
    SMTP_USER: smtp.user,
    SMTP_PASS: smtp.pass,
    SMTP_FROM: smtp.from,
    SMTP_SECURE: smtp.secure ? "true" : "false",
  };
}
