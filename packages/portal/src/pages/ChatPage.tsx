import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, JobKind } from "@vibe/shared";
import {
  useApps,
  useConversation,
  useMachineStatus,
  useSendMessage,
} from "../lib/queries";
import { streamJob } from "../lib/stream";
import { Composer } from "../components/Composer";
import { MachinePill } from "../components/MachinePill";
import { LoadingBlock, Spinner } from "../components/States";

/** Live buffer for the assistant message currently streaming. */
interface Live {
  asstId: string;
  text: string;
  tools: string[];
  error?: string;
  active: boolean;
}

function ToolChip({ name }: { name: string }) {
  return (
    <span className="pill mr-1.5 mb-1 bg-[var(--color-surface-2)] text-[var(--color-muted)]">
      <span aria-hidden>⚙</span> {name}
    </span>
  );
}

function Bubble({
  role,
  children,
  status,
  tools,
  streaming,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
  status?: ChatMessage["status"];
  tools?: string[];
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
            {isUser ? "You" : "Claude"}
          </span>
          {status === "failed" && (
            <span className="text-[10px] font-semibold uppercase text-[var(--color-bad)]">failed</span>
          )}
        </div>
        {tools && tools.length > 0 && (
          <div className="mb-1.5 flex flex-wrap">
            {tools.map((t, i) => (
              <ToolChip key={i} name={t} />
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
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

export function ChatPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { data: conv, isLoading, refetch } = useConversation(id);
  const { data: apps } = useApps();
  const { data: machine, isLoading: mLoading } = useMachineStatus();
  const send = useSendMessage(id);

  // Optimistic messages shown immediately on send, until the refetch picks
  // up the authoritative ones; and the live streaming buffer.
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const resumedFor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clean up any stream on unmount / conversation change.
  useEffect(() => {
    return () => disposeRef.current?.();
  }, [id]);

  const startStream = (asstId: string) => {
    disposeRef.current?.();
    setLive({ asstId, text: "", tools: [], active: true });
    disposeRef.current = streamJob(id, 0, {
      onEvent: (e) =>
        setLive((cur) => {
          if (!cur || cur.asstId !== asstId) return cur;
          if (e.type === "text")
            return { ...cur, text: cur.text + (typeof e.data.text === "string" ? e.data.text : "") };
          if (e.type === "tool")
            return { ...cur, tools: [...cur.tools, String(e.data.name ?? "tool")] };
          if (e.type === "error")
            return { ...cur, error: String(e.data.error ?? "error") };
          return cur;
        }),
      onDone: async () => {
        await refetch();
        qc.invalidateQueries({ queryKey: ["conversations"] });
        setOptimistic([]);
        setLive(null);
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

  const onSend = async (content: string, kind: JobKind, targetApp: string | null) => {
    const now = new Date().toISOString();
    try {
      const res = await send.mutateAsync({ content, kind, targetApp });
      setOptimistic([
        { id: res.userMessageId, role: "user", content, status: "done", createdAt: now },
        { id: res.assistantMessageId, role: "assistant", content: "", status: "pending", createdAt: now },
      ]);
      startStream(res.assistantMessageId);
    } catch {
      /* error surfaced via send.error below */
    }
  };

  // Merge history with optimistic (optimistic ids are dropped once history has them).
  const history = conv?.messages ?? [];
  const historyIds = new Set(history.map((m) => m.id));
  const thread: ChatMessage[] = [...history, ...optimistic.filter((m) => !historyIds.has(m.id))];

  // Auto-scroll to the newest content as it streams in.
  useLayoutEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length, live?.text, live?.tools.length]);

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
                <Bubble role="assistant" tools={live!.tools} streaming={live!.active} status={m.status}>
                  {live!.text || (
                    <span className="inline-flex items-center gap-2 text-[var(--color-muted)]">
                      <Spinner /> thinking…
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
              {m.content || (
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
        apps={apps ?? []}
        defaultTargetApp={conv.targetApp}
        sending={send.isPending}
        onSend={onSend}
      />
    </div>
  );
}
