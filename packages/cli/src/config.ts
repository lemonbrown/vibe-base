import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Credentials {
  /** Control-plane base URL, e.g. https://vibe.example.com */
  apiUrl: string;
  /** Owner bearer token. */
  token: string;
}

function credPath(): string {
  return join(homedir(), ".vibe", "credentials.json");
}

/** Resolve credentials from env first, then ~/.vibe/credentials.json. */
export async function loadCredentials(): Promise<Credentials> {
  const envUrl = process.env.VIBE_API_URL;
  const envToken = process.env.VIBE_TOKEN;
  if (envUrl && envToken) return { apiUrl: envUrl.replace(/\/$/, ""), token: envToken };

  try {
    const raw = await readFile(credPath(), "utf8");
    const parsed = JSON.parse(raw) as Credentials;
    return {
      apiUrl: (envUrl ?? parsed.apiUrl).replace(/\/$/, ""),
      token: envToken ?? parsed.token,
    };
  } catch {
    throw new Error(
      "Not logged in. Run `vibe login --url <control-plane-url> --token <owner-token>` " +
        "or set VIBE_API_URL and VIBE_TOKEN."
    );
  }
}

/** True if credentials are available (env or saved file), without throwing. */
export async function hasCredentials(): Promise<boolean> {
  if (process.env.VIBE_API_URL && process.env.VIBE_TOKEN) return true;
  try {
    const raw = await readFile(credPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    return Boolean(parsed.apiUrl && parsed.token);
  } catch {
    return false;
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const p = credPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(creds, null, 2), "utf8");
}
