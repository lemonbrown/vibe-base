import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { JobKind } from "@vibe/shared";
import { classNames } from "../lib/format";

export interface ChatTriggerAction {
  label: string;
  prompt: string;
  kind?: JobKind;
  targetApp?: string | null;
  planMode?: boolean;
  variant?: "primary" | "secondary";
}

interface ChoiceGroup {
  label?: string;
  options: ChatTriggerAction[];
}

interface ParsedMessage {
  markdown: string;
  actions: ChatTriggerAction[];
  choices: ChoiceGroup[];
}

const TRIGGER_BLOCK_RE =
  /(^|\n)```(?:vibe-ui|vibe-trigger|vibe-triggers)\s*\n([\s\S]*?)\n```(?=\n|$)/g;
const JOB_KINDS: JobKind[] = ["ask", "build", "adjust"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asKind(value: unknown): JobKind | undefined {
  return typeof value === "string" && (JOB_KINDS as string[]).includes(value)
    ? (value as JobKind)
    : undefined;
}

function normalizeAction(value: unknown): ChatTriggerAction | null {
  if (!isRecord(value)) return null;
  const label = asString(value.label) ?? asString(value.title);
  const prompt =
    asString(value.prompt) ?? asString(value.message) ?? asString(value.value) ?? label;
  if (!label || !prompt) return null;

  return {
    label,
    prompt,
    kind: asKind(value.kind),
    targetApp:
      value.targetApp === null
        ? null
        : asString(value.targetApp) ?? asString(value.target_app),
    planMode: typeof value.planMode === "boolean" ? value.planMode : undefined,
    variant: value.variant === "primary" ? "primary" : "secondary",
  };
}

function normalizeActions(value: unknown): ChatTriggerAction[] {
  return Array.isArray(value)
    ? value.map(normalizeAction).filter((a): a is ChatTriggerAction => a !== null)
    : [];
}

function normalizeChoice(value: unknown): ChoiceGroup | null {
  if (!isRecord(value)) return null;
  const options = normalizeActions(value.options);
  if (!options.length) return null;
  return {
    label: asString(value.label) ?? asString(value.title),
    options,
  };
}

function mergePayload(parsed: ParsedMessage, payload: unknown): void {
  if (Array.isArray(payload)) {
    parsed.actions.push(...normalizeActions(payload));
    return;
  }
  if (!isRecord(payload)) return;

  const topLevelAction = normalizeAction(payload);
  if (topLevelAction) parsed.actions.push(topLevelAction);

  parsed.actions.push(...normalizeActions(payload.actions));
  parsed.actions.push(...normalizeActions(payload.buttons));
  parsed.actions.push(...normalizeActions(payload.triggers));

  if (Array.isArray(payload.choices)) {
    parsed.choices.push(
      ...payload.choices
        .map(normalizeChoice)
        .filter((c): c is ChoiceGroup => c !== null)
    );
  }
}

export function parseMessageTriggers(content: string): ParsedMessage {
  const parsed: ParsedMessage = { markdown: content, actions: [], choices: [] };
  parsed.markdown = content.replace(TRIGGER_BLOCK_RE, (full, leading: string, raw: string) => {
    try {
      mergePayload(parsed, JSON.parse(raw));
      return leading;
    } catch {
      return full;
    }
  });
  return parsed;
}

function TriggerButton({
  action,
  disabled,
  onTrigger,
}: {
  action: ChatTriggerAction;
  disabled?: boolean;
  onTrigger?: (action: ChatTriggerAction) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || !onTrigger}
      onClick={() => onTrigger?.(action)}
      className={classNames(
        action.variant === "primary" ? "btn-primary" : "btn-ghost",
        "min-h-9 px-3 py-1.5 text-xs"
      )}
      title={action.prompt}
    >
      {action.label}
    </button>
  );
}

export function MarkdownMessage({
  content,
  interactive = false,
  triggersDisabled = false,
  onTrigger,
}: {
  content: string;
  interactive?: boolean;
  triggersDisabled?: boolean;
  onTrigger?: (action: ChatTriggerAction) => void;
}) {
  const parsed = interactive
    ? parseMessageTriggers(content)
    : { markdown: content, actions: [], choices: [] };
  const hasTriggers =
    interactive && (parsed.actions.length > 0 || parsed.choices.length > 0);

  return (
    <>
      <div className="chat-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {parsed.markdown}
        </ReactMarkdown>
      </div>

      {hasTriggers && (
        <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
          {parsed.actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {parsed.actions.map((action, i) => (
                <TriggerButton
                  key={`${action.label}-${i}`}
                  action={action}
                  disabled={triggersDisabled}
                  onTrigger={onTrigger}
                />
              ))}
            </div>
          )}
          {parsed.choices.map((choice, i) => (
            <div key={`${choice.label ?? "choice"}-${i}`}>
              {choice.label && (
                <p className="mb-1.5 text-xs font-medium text-[var(--color-muted)]">
                  {choice.label}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {choice.options.map((action, j) => (
                  <TriggerButton
                    key={`${action.label}-${j}`}
                    action={action}
                    disabled={triggersDisabled}
                    onTrigger={onTrigger}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
