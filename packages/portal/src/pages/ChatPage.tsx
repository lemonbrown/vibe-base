import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatAttachment, ChatMessage, JobKind } from "@vibe/shared";
import {
  useConversation,
  useMachineStatus,
  useSendMessage,
  useStopConversation,
} from "../lib/queries";
import { streamJob } from "../lib/stream";
import { Composer } from "../components/Composer";
import {
  MarkdownMessage,
  type ChatTriggerAction,
} from "../components/MarkdownMessage";
import { MachinePill } from "../components/MachinePill";
import { LoadingBlock, Spinner } from "../components/States";
import { attachmentSummary } from "../lib/attachments";

/** Live buffer for the assistant message currently streaming. */
interface Live {
  asstId: string;
  text: string;
  thinking: string;
  statusText: string;
  error?: string;
  active: boolean;
  stopping?: boolean;
  startedAt: number;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function displayContent(content: string, attachments: ChatAttachment[] = []): string {
  if (!attachments.length) return content;
  const attachmentText = attachments
    .map((att) => `- ${attachmentSummary(att)}`)
    .join("\n");
  return [content, `Attachments:\n${attachmentText}`].filter(Boolean).join("\n\n");
}

function Bubble({
  role,
  children,
  status,
  streaming,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
  status?: ChatMessage["status"];
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-[var(--color-brand-soft)] px-4 py-2.5"
            : "max-w-[90%] rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5"
        }
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
            {isUser ? "You" : "Agent"}
          </span>
          {(status === "failed" || status === "stopped") && (
            <span className="text-[10px] font-semibold uppercase text-[var(--color-bad)]">
              {status === "stopped" ? "stopped" : "failed"}
            </span>
          )}
        </div>
        <div className="break-words text-sm leading-relaxed">
          {children}
          {streaming && <Caret />}
        </div>
      </div>
    </div>
  );
}

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-[var(--color-brand)] align-middle" />
  );
}

function ThinkingBlock({ text, active, elapsed }: { text: string; active: boolean; elapsed?: number }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const elapsedStr = elapsed !== undefined && elapsed > 0 ? ` · ${formatElapsed(elapsed)}` : "";
  return (
    <div className="mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-muted)] hover:text-[var(--color-text)]"
      >
        <span className={active && !text ? "animate-pulse" : ""}>{active && !text ? "⏳" : "💭"}</span>
        <span className="flex-1 font-medium">{active && !text ? `Thinking…${elapsedStr}` : "Thinking"}</span>
        {text && <span className="text-[var(--color-faint)]">{open ? "▲" : "▼"}</span>}
      </button>
      {open && text && (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[var(--color-faint)] leading-relaxed">
          {text}
        </pre>
      )}
    </div>
  );
}

export function ChatPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { data: conv, isLoading, refetch } = useConversation(id);
  const { data: machine, isLoading: mLoading } = useMachineStatus();
  const send = useSendMessage(id);
  const stopMutation = useStopConversation(id);

  // Optimistic messages shown immediately on send, until the refetch picks
  // up the authoritative ones; and the live streaming buffer.
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const disposeRef = useRef<(() => void) | null>(null);
  const resumedFor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clean up any stream on unmount / conversation change.
  useEffect(() => {
    return () => disposeRef.current?.();
  }, [id]);

  // Tick the elapsed timer while a job is actively streaming.
  useEffect(() => {
    if (!live?.active) { setElapsed(0); return; }
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - live.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [live?.active, live?.startedAt]);

  const startStream = (asstId: string) => {
    disposeRef.current?.();
    setElapsed(0);
    setLive({ asstId, text: "", thinking: "", statusText: "", active: true, startedAt: Date.now() });
    disposeRef.current = streamJob(id, 0, {
      onEvent: (e) =>
        setLive((cur) => {
          if (!cur || cur.asstId !== asstId) return cur;
          if (e.type === "text")
            return { ...cur, text: cur.text + (typeof e.data.text === "string" ? e.data.text : "") };
          if (e.type === "thinking")
            return { ...cur, thinking: cur.thinking + (typeof e.data.text === "string" ? e.data.text : "") };
          if (e.type === "tool")
            return cur;
          if (e.type === "error")
            return { ...cur, error: String(e.data.error ?? "error") };
          if (e.type === "status") {
            const phase = typeof e.data.phase === "string" ? e.data.phase : "";
            const output = typeof e.data.output === "string" ? e.data.output : "";
            const event = typeof e.data.event === "string" ? e.data.event : "";
            let label = "";
            if (phase === "tool_result") {
              label = output;
            } else if (phase === "init") {
              label = "Initialized";
            } else if (event) {
              // Map known Codex event types to friendly labels; drop the rest.
              const codexLabels: Record<string, string> = {
                "response.created": "Starting…",
                "response.in_progress": "Thinking…",
                "response.completed": "Completed",
                "response.failed": "Failed",
                "tool_call.in_progress": "Running tool…",
                "tool_call.completed": "Tool done",
              };
              label = codexLabels[event] ?? "";
            }
            return label ? { ...cur, statusText: label } : cur;
          }
          return cur;
        }),
      onDone: async () => {
        await refetch();
        qc.invalidateQueries({ queryKey: ["conversations"] });
        setOptimistic([]);
        setLive(null);
        setElapsed(0);
      },
    });
  };

  // Resume streaming if we land on a conversation whose last message is still
  // in flight (e.g. opened from another device, or returned mid-job).
  useEffect(() => {
    if (!conv || live || resumedFor.current === id) return;
    const last = conv.messages[conv.messages.length - 1];
    if (last && last.role === "assistant" && (last.status === "pending" || last.status === "streaming")) {
      resumedFor.current = id;
      startStream(last.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv, id, live]);

  const handleStop = () => {
    if (!live?.active || live.stopping) return;
    setLive((cur) => cur ? { ...cur, stopping: true } : cur);
    stopMutation.mutate();
  };

  const onSend = async (
    content: string,
    kind: JobKind,
    targetApp: string | null,
    planMode: boolean,
    attachments: ChatAttachment[] = []
  ) => {
    const now = new Date().toISOString();
    const shownContent = displayContent(content, attachments);
    try {
      const res = await send.mutateAsync({ content, kind, targetApp, planMode, attachments });
      setOptimistic([
        { id: res.userMessageId, role: "user", content: shownContent, status: "done", createdAt: now },
        { id: res.assistantMessageId, role: "assistant", content: "", status: "pending", createdAt: now },
      ]);
      startStream(res.assistantMessageId);
    } catch {
      /* error surfaced via send.error below */
    }
  };

  const onTrigger = (action: ChatTriggerAction) => {
    if (send.isPending || live?.active) return;
    onSend(
      action.prompt,
      action.kind ?? "chat",
      action.targetApp === undefined ? conv?.targetApp ?? null : action.targetApp,
      action.planMode ?? false
    );
  };

  // Merge history with optimistic (optimistic ids are dropped once history has them).
  const history = conv?.messages ?? [];
  const historyIds = new Set(history.map((m) => m.id));
  const thread: ChatMessage[] = [...history, ...optimistic.filter((m) => !historyIds.has(m.id))];

  // Auto-scroll to the newest content as it streams in.
  useLayoutEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length, live?.text, live?.thinking]);

  if (isLoading) return <LoadingBlock label="Loading conversation…" />;
  if (!conv)
    return (
      <div className="py-10 text-center text-sm text-[var(--color-muted)]">
        Conversation not found. <Link to="/chat" className="text-[var(--color-brand)]">Back to chat</Link>
      </div>
    );

  const offline = machine && !machine.online;

  return (
    // Fill the viewport below the header so the composer can sit at the bottom.
    <div className="flex min-h-[calc(100vh-9rem)] flex-col sm:min-h-[calc(100vh-7rem)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Link to="/chat" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">
            ← Conversations
          </Link>
          <h1 className="truncate text-lg font-semibold">{conv.title}</h1>
        </div>
        <MachinePill machine={machine} loading={mLoading} />
      </div>

      {offline && (
        <div className="mb-3 rounded-lg border border-[#5a4a27] bg-[#1c170f] px-3 py-2 text-sm text-[var(--color-warn)]">
          Your machine is offline — messages will queue and run once{" "}
          <code className="font-mono text-xs">vibe agent</code> is back online.
        </div>
      )}

      {/* Thread */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-4">
        {thread.length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--color-muted)]">
            Send a message to get started.
          </p>
        )}
        {thread.map((m) => {
          const isLive = live && live.asstId === m.id;
          if (m.role === "assistant" && isLive) {
            return (
              <div key={m.id}>
                <Bubble role="assistant" streaming={live!.active && !!live!.text} status={m.status}>
                  {(live!.thinking || (live!.active && !live!.text)) && (
                    <ThinkingBlock text={live!.thinking} active={live!.active} elapsed={elapsed} />
                  )}
                  {live!.text ? (
                    <>
                      <MarkdownMessage
                        content={live!.text}
                        interactive
                        triggersDisabled={live!.active || send.isPending}
                        onTrigger={onTrigger}
                      />
                      {live!.statusText && live!.active && (
                        <p className="mt-1.5 truncate font-mono text-[10px] text-[var(--color-faint)]">
                          {live!.statusText}
                        </p>
                      )}
                    </>
                  ) : live!.statusText ? (
                    <p className="mb-1.5 text-xs italic text-[var(--color-faint)]">{live!.statusText}</p>
                  ) : !live!.thinking && (
                    <span className="inline-flex items-center gap-2 text-[var(--color-muted)]">
                      <Spinner /> waiting for agent…
                    </span>
                  )}
                </Bubble>
                {live!.error && (
                  <p className="mt-1 pl-1 text-xs text-[var(--color-bad)]">⚠ {live!.error}</p>
                )}
              </div>
            );
          }
          return (
            <Bubble key={m.id} role={m.role} status={m.status}>
              {m.content ? (
                <MarkdownMessage
                  content={m.content}
                  interactive={m.role === "assistant"}
                  triggersDisabled={send.isPending || !!live?.active}
                  onTrigger={onTrigger}
                />
              ) : (
                <span className="text-[var(--color-faint)]">
                  {m.status === "failed" ? "(no response)" : "…"}
                </span>
              )}
            </Bubble>
          );
        })}
        <div ref={scrollRef} />
      </div>

      {send.error && (
        <p className="mb-2 text-sm text-[var(--color-bad)]">{(send.error as Error).message}</p>
      )}

      <Composer
        sending={send.isPending}
        streaming={live?.active}
        stopping={live?.stopping}
        onSend={onSend}
        onStop={handleStop}
      />
    </div>
  );
}
