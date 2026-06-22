import { createHash, createHmac } from "node:crypto";
import { loadConfig } from "../config.js";
import { one, query } from "../db.js";

/**
 * MVP storage model (spec §16): one bucket per app on the platform's
 * S3-compatible store (MinIO). The app receives root credentials plus its
 * bucket name. Per-app IAM isolation is deferred; the bucket boundary keeps
 * objects separated between apps.
 */

interface StorageRow {
  app_id: string;
  bucket: string;
  prefix: string;
  access_key: string;
  secret_key: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

type S3Method = "GET" | "PUT" | "HEAD" | "DELETE";

/** AWS-flavoured RFC 3986 encoding. encodeSlash=false keeps "/" for paths. */
function uriEncode(str: string, encodeSlash = true): string {
  const enc = encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return encodeSlash ? enc : enc.replace(/%2F/g, "/");
}

/**
 * Minimal AWS SigV4 signed request against the (MinIO) S3 endpoint.
 * `path` is the full resource path ("/bucket" or "/bucket/key"); `query`
 * holds any sub-resource/list parameters. The wire URL is built from the same
 * canonical encoding used for signing so the two never drift.
 */
async function s3(
  method: S3Method,
  path: string,
  query: Record<string, string> = {}
): Promise<Response> {
  const cfg = loadConfig().storage;
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = uriEncode(path, false);
  const queryKeys = Object.keys(query).sort();
  const canonicalQuery = queryKeys
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join("&");
  const target = `${cfg.endpoint.replace(/\/$/, "")}${canonicalUri}${
    canonicalQuery ? `?${canonicalQuery}` : ""
  }`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.rootPassword}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.rootUser}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(target, {
    method,
    headers: {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization,
    },
  });
}

async function ensureBucket(bucket: string): Promise<void> {
  const head = await s3("HEAD", `/${bucket}`);
  if (head.ok) return;
  const put = await s3("PUT", `/${bucket}`);
  // 200/409 (already owned) are both fine.
  if (!put.ok && put.status !== 409) {
    throw new Error(`bucket create failed (${put.status}): ${await put.text()}`);
  }
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** List every object key in a bucket, following ListObjectsV2 pagination. */
async function listObjects(bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2" };
    if (token) query["continuation-token"] = token;
    const res = await s3("GET", `/${bucket}`, query);
    if (res.status === 404) return keys; // bucket already gone
    if (!res.ok) {
      throw new Error(`list objects failed (${res.status}): ${await res.text()}`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      keys.push(xmlUnescape(m[1]!));
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (token);
  return keys;
}

function bucketName(appId: string): string {
  return `vibe-${appId}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

/** Ensure storage is provisioned for the app; idempotent. */
export async function provisionStorage(appId: string): Promise<StorageRow> {
  const existing = await one<StorageRow>(
    "SELECT * FROM storage_provisions WHERE app_id = $1",
    [appId]
  );
  if (existing) {
    await ensureBucket(existing.bucket);
    return existing;
  }

  const cfg = loadConfig().storage;
  const bucket = bucketName(appId);
  await ensureBucket(bucket);

  const row: StorageRow = {
    app_id: appId,
    bucket,
    prefix: "",
    access_key: cfg.rootUser,
    secret_key: cfg.rootPassword,
  };
  await query(
    `INSERT INTO storage_provisions (app_id, bucket, prefix, access_key, secret_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (app_id) DO NOTHING`,
    [row.app_id, row.bucket, row.prefix, row.access_key, row.secret_key]
  );
  return row;
}

/** S3 env vars injected into the app container. */
export async function storageEnvFor(
  appId: string
): Promise<Record<string, string> | null> {
  const row = await one<StorageRow>(
    "SELECT * FROM storage_provisions WHERE app_id = $1",
    [appId]
  );
  if (!row) return null;
  const cfg = loadConfig().storage;
  return {
    S3_ENDPOINT: cfg.publicEndpoint,
    S3_INTERNAL_ENDPOINT: cfg.endpoint,
    S3_REGION: cfg.region,
    S3_BUCKET: row.bucket,
    S3_ACCESS_KEY_ID: row.access_key,
    S3_SECRET_ACCESS_KEY: row.secret_key,
    S3_FORCE_PATH_STYLE: "true",
  };
}

export async function isStorageProvisioned(appId: string): Promise<boolean> {
  const res = await query("SELECT 1 FROM storage_provisions WHERE app_id = $1", [
    appId,
  ]);
  return !!res.rowCount;
}

/**
 * Empty and delete the app's bucket, then drop the provisioning record.
 * Idempotent: a no-op when nothing was provisioned, and tolerant of a bucket
 * that has already been removed. S3 refuses to delete a non-empty bucket, so
 * every object is removed first.
 */
export async function deprovisionStorage(appId: string): Promise<void> {
  const row = await one<StorageRow>(
    "SELECT * FROM storage_provisions WHERE app_id = $1",
    [appId]
  );
  if (!row) return;

  for (const key of await listObjects(row.bucket)) {
    const del = await s3("DELETE", `/${row.bucket}/${key}`);
    if (!del.ok && del.status !== 404) {
      throw new Error(`delete object '${key}' failed (${del.status})`);
    }
  }

  const del = await s3("DELETE", `/${row.bucket}`);
  if (!del.ok && del.status !== 404) {
    throw new Error(`delete bucket failed (${del.status}): ${await del.text()}`);
  }

  await query("DELETE FROM storage_provisions WHERE app_id = $1", [appId]);
}
