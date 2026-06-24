import { loadConfig } from "../config.js";

/**
 * Platform email (spec §17, MVP): a single shared sender configured on the
 * control plane. Apps that declare `capabilities.email` receive email env and
 * send themselves — no per-app provisioning (cf. services/storage).
 *
 * Transports are selected by what's configured, in precedence order:
 *  - "resend": Resend HTTPS API. Simplest; sends from a verified domain. No
 *    SMTP ports, no OAuth. Highest precedence when set.
 *  - "gmail-api": Gmail API over HTTPS (OAuth2). Works where outbound SMTP is
 *    blocked (e.g. DigitalOcean); sends as the configured Gmail account.
 *  - "smtp": plain SMTP (nodemailer). Simple, but needs ports 465/587 open.
 * Apps branch on the injected EMAIL_PROVIDER var.
 */

export type EmailProvider = "resend" | "gmail-api" | "smtp";

export function emailProvider(): EmailProvider | null {
  const { gmail, smtp, resend } = loadConfig();
  if (resend.apiKey && resend.from) return "resend";
  if (gmail.clientId && gmail.clientSecret && gmail.refreshToken && (gmail.from || smtp.from)) {
    return "gmail-api";
  }
  if (smtp.host && smtp.user && smtp.from) return "smtp";
  return null;
}

export function emailConfigured(): boolean {
  return emailProvider() !== null;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email from the control plane using the configured provider.
 * Returns true on success, false when email is not configured or the send fails.
 * Only Resend and Gmail API are supported; SMTP is app-only.
 */
export async function sendEmail(msg: EmailPayload): Promise<boolean> {
  const provider = emailProvider();
  if (!provider || provider === "smtp") return false;
  const cfg = loadConfig();

  if (provider === "resend") {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.resend.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.resend.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  if (provider === "gmail-api") {
    try {
      const from = cfg.gmail.from || cfg.smtp.from;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.gmail.clientId,
          client_secret: cfg.gmail.clientSecret,
          refresh_token: cfg.gmail.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) return false;
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const raw = [
        `From: ${from}`,
        `To: ${msg.to}`,
        `Subject: ${msg.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=UTF-8`,
        ``,
        msg.html,
      ].join("\r\n");

      const sendRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
        }
      );
      return sendRes.ok;
    } catch {
      return false;
    }
  }

  return false;
}

/** Email env vars injected into an app container when email is enabled. */
export function emailEnvFor(): Record<string, string> | null {
  const { gmail, smtp, resend } = loadConfig();
  const provider = emailProvider();
  if (!provider) return null;

  if (provider === "resend") {
    return {
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: resend.from,
      RESEND_API_KEY: resend.apiKey,
      RESEND_FROM: resend.from,
    };
  }

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
