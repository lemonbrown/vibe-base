import { z } from "zod";
import { ManifestSchema } from "./manifest.js";

/** Platform-level roles. App-specific roles are declared in the manifest. */
export const PlatformRoleSchema = z.enum(["owner", "leader", "member"]);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

export const DeployStatusSchema = z.enum([
  "queued",
  "building",
  "migrating",
  "starting",
  "health_check",
  "live",
  "failed",
]);
export type DeployStatus = z.infer<typeof DeployStatusSchema>;

export const HealthSchema = z.enum(["healthy", "unhealthy", "unknown"]);
export type Health = z.infer<typeof HealthSchema>;

/* ----------------------------- API: apps ------------------------------ */

export const RegisterAppRequestSchema = z.object({
  manifest: ManifestSchema,
});
export type RegisterAppRequest = z.infer<typeof RegisterAppRequestSchema>;

export const AppSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.string(),
  status: z.string(),
  url: z.string().nullable(),
  health: HealthSchema,
  currentDeploymentId: z.string().nullable(),
  lastDeployedAt: z.string().nullable(),
  icon: z.string().nullable(),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

/* --------------------------- API: deploy ------------------------------ */

export const DeploySourceSchema = z.enum(["context", "image"]);
export type DeploySource = z.infer<typeof DeploySourceSchema>;

export const DeploymentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  status: DeployStatusSchema,
  imageTag: z.string().nullable(),
  health: HealthSchema,
  error: z.string().nullable(),
  source: DeploySourceSchema,
  gitSha: z.string().nullable(),
  gitRef: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

/* --------------------------- API: status ------------------------------ */

export const AppStatusSchema = z.object({
  app: AppSummarySchema,
  manifestSummary: z.object({
    runtimeAdapter: z.string(),
    port: z.number(),
    healthPath: z.string(),
    capabilities: z.record(z.boolean()),
  }),
  database: z.object({
    enabled: z.boolean(),
    provisioned: z.boolean(),
  }),
  storage: z.object({
    enabled: z.boolean(),
    provisioned: z.boolean(),
  }),
  members: z.number(),
  recentDeployments: z.array(DeploymentSchema),
});
export type AppStatus = z.infer<typeof AppStatusSchema>;

/* -------------------------- API: members ------------------------------ */

export const InviteRequestSchema = z.object({
  email: z.string().email(),
  role: PlatformRoleSchema.default("member"),
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

export const MemberSchema = z.object({
  email: z.string(),
  role: PlatformRoleSchema,
  status: z.enum(["invited", "active", "revoked"]),
  invitedAt: z.string(),
});
export type Member = z.infer<typeof MemberSchema>;

/* ----------------------- Secret presence map -------------------------- */
/** Per spec §23.1: the LLM sees which secrets exist, never their values. */
export const SecretPresenceSchema = z.record(
  z.object({
    present: z.boolean(),
    type: z.string().optional(),
    required: z.boolean().optional(),
  })
);
export type SecretPresence = z.infer<typeof SecretPresenceSchema>;

/* ---------------------- API: platform query layer --------------------- */
/**
 * The read-only surface an LLM uses to reason about the live platform. Every
 * response here is deliberately projected to be secret-free — it carries the
 * *presence* and *shape* of things (which apps, which secrets exist, which
 * read-models), never credential values. See spec §23.1.
 */

/** One app's line in the platform overview. */
export interface PlatformAppLine {
  id: string;
  name: string;
  status: string;
  health: Health;
  url: string | null;
  visibility: string;
  lastDeployedAt: string | null;
  members: number;
  readModels: number;
  database: boolean;
  storage: boolean;
}

export interface PlatformOverview {
  generatedAt: string;
  totals: { apps: number; live: number; unhealthy: number };
  apps: PlatformAppLine[];
}

/** Describes a queryable read-model to the LLM (no SQL leaked). */
export interface ReadModelInfo {
  name: string;
  description: string;
  params: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
}

export interface PlatformAppDetail {
  app: AppSummary;
  description: string;
  manifestSummary: {
    runtimeAdapter: string;
    port: number;
    healthPath: string;
    capabilities: Record<string, boolean>;
  };
  access: { mode: string; defaultRole: string; visibility: string; roles: string[] };
  database: { enabled: boolean; provisioned: boolean };
  storage: { enabled: boolean; provisioned: boolean };
  members: Array<{ email: string; role: string; status: string }>;
  recentDeployments: Deployment[];
  repo: { repoFullName: string; defaultBranch: string; htmlUrl: string | null } | null;
  /** Which secrets exist for this app — names only, never values. */
  secrets: SecretPresence;
  readModels: ReadModelInfo[];
}

/** The result of running a read-model. */
export interface ReadModelResult {
  app: string;
  model: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the result was capped at the row limit. */
  truncated: boolean;
}

/* ----------------------- API: chat relay (Pattern B) ------------------ */
/**
 * The portal chat → control-plane → on-machine daemon relay. A user message
 * becomes a job that a `vibe agent` daemon on the owner's machine claims, runs
 * with the selected local LLM provider, and streams events back to fill the
 * assistant message.
 */

/** chat = LLM infers intent; ask = read-only question; build = new app; adjust = edit app; verify = post-deploy test run. */
export type JobKind = "chat" | "ask" | "build" | "adjust" | "verify";
export type JobStatus = "queued" | "claimed" | "running" | "done" | "failed" | "cancelling" | "stopped";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "streaming" | "done" | "failed" | "stopped";
export type LlmProvider = "claude" | "codex";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  targetApp: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: ChatMessage[];
}

/** A streamed event from the daemon as the selected LLM works (no secrets). */
export interface JobEvent {
  seq: number;
  /** text = assistant output chunk; tool = a tool call; thinking = reasoning trace; status/error/done = lifecycle. */
  type: "text" | "tool" | "thinking" | "status" | "error" | "done";
  data: Record<string, unknown>;
}

/** The owner's registered relay machine and whether its daemon is reachable. */
export interface MachineStatus {
  name: string;
  lastSeenAt: string | null;
  /** True when the daemon checked in recently (heartbeat within the window). */
  online: boolean;
}

/** A unit of work handed to a daemon. */
export interface AgentJob {
  id: string;
  convId: string;
  messageId: string | null;
  kind: JobKind;
  targetApp: string | null;
  instruction: string;
  /** Which local coding agent CLI should run this job. */
  llmProvider: LlmProvider;
  /** Provider-specific model id or alias, e.g. sonnet, opus, gpt-5. */
  llmModel: string;
  /** Prior provider session to resume for multi-turn conversations. */
  llmSessionId: string | null;
  /** When true, run the provider in plan/research mode instead of editing/executing. */
  planMode: boolean;
  /** Stack/preferences policy to append to the provider prompt. Snapshotted from owner settings at send time. */
  stackPolicy: string | null;
  /** Reasoning effort for providers that support it (e.g. OpenAI o-series). null = use provider default. */
  llmReasoningEffort: string | null;
}

/** Per-owner chat settings configured from the portal. */
export interface OwnerSettings {
  /** Free-text stack/preferences injected into chat jobs. */
  stackPolicy: string;
  /** Initial state of the chat composer's plan-mode toggle. */
  planModeDefault: boolean;
  /** Default local LLM runner for new chat jobs. */
  llmProvider: LlmProvider;
  /** Default provider model id or alias for new chat jobs. */
  llmModel: string;
  /** Reasoning effort level for providers that support it (OpenAI o-series). null = use provider default. */
  llmReasoningEffort: string | null;
}
