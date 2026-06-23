import { Link, useNavigate } from "react-router-dom";
import { useConversations, useMachineStatus, useNewConversation } from "../lib/queries";
import { MachinePill } from "../components/MachinePill";
import { EmptyState, LoadingBlock } from "../components/States";
import { relativeTime } from "../lib/format";

export function ChatListPage() {
  const { data: convs, isLoading } = useConversations();
  const { data: machine, isLoading: mLoading } = useMachineStatus();
  const newChat = useNewConversation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Chat</h1>
        <MachinePill machine={machine} loading={mLoading} />
      </div>

      <p className="text-sm text-[var(--color-muted)]">
        Messages run your selected local LLM (via{" "}
        <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs">vibe agent</code>
        ) on your machine — ask about your data, build a new app, or adjust one.
      </p>

      <button
        className="btn-primary self-start"
        disabled={newChat.isPending}
        onClick={() =>
          newChat.mutate(undefined, {
            onSuccess: (c) => navigate(`/chat/${c.id}`),
          })
        }
      >
        {newChat.isPending ? "Creating…" : "+ New chat"}
      </button>

      {isLoading ? (
        <LoadingBlock label="Loading conversations…" />
      ) : convs && convs.length > 0 ? (
        <div className="card divide-y divide-[var(--color-border)]">
          {convs.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span className="min-w-0 truncate">{c.title}</span>
              <span className="shrink-0 text-xs text-[var(--color-faint)]">
                {relativeTime(c.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState title="No conversations yet">
          Start one to ask about your live data or describe an app to build.
        </EmptyState>
      )}
    </div>
  );
}
