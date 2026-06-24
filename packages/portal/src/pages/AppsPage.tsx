import { useState } from "react";
import { Link } from "react-router-dom";
import type { AppSummary } from "@vibe/shared";
import { useApps } from "../lib/queries";
import { HealthBadge, StatusPill } from "../components/ui";
import { EmptyState, InlineError, LoadingBlock } from "../components/States";
import { relativeTime } from "../lib/format";

function AppIcon({ svg }: { svg: string }) {
  return (
    <img
      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
      alt=""
      aria-hidden
      className="h-full w-full"
    />
  );
}

type Mode = "open" | "details";

const healthColor: Record<string, string> = {
  healthy: "var(--color-ok)",
  unhealthy: "var(--color-bad)",
  unknown: "var(--color-warn)",
};

function AppCard({ app, mode }: { app: AppSummary; mode: Mode }) {
  const className =
    "card group flex flex-col gap-3 p-4 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]";

  if (mode === "open") {
    const body = (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-surface-2)]">
            {app.icon ? (
              <AppIcon svg={app.icon} />
            ) : (
              <span className="text-lg font-semibold text-[var(--color-muted)]">
                {app.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <h3 className="truncate font-medium group-hover:text-white">{app.name}</h3>
        </div>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: healthColor[app.health] ?? healthColor.unknown }}
          aria-hidden
        />
      </div>
    );

    if (app.url) {
      return (
        <a href={app.url} target="_blank" rel="noopener noreferrer" className={className}>
          {body}
        </a>
      );
    }

    return (
      <Link to={`/apps/${app.id}`} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <Link to={`/apps/${app.id}`} className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-surface-2)]">
            {app.icon ? (
              <AppIcon svg={app.icon} />
            ) : (
              <span className="text-lg font-semibold text-[var(--color-muted)]">
                {app.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-medium group-hover:text-white">{app.name}</h3>
            <p className="truncate text-xs text-[var(--color-faint)]">{app.id}</p>
          </div>
        </div>
        <HealthBadge health={app.health} />
      </div>
      <div className="flex items-center gap-2">
        <StatusPill status={app.status} />
        <span className="text-xs text-[var(--color-muted)]">
          {app.lastDeployedAt ? `deployed ${relativeTime(app.lastDeployedAt)}` : "not deployed"}
        </span>
      </div>
      {app.url && (
        <span className="truncate text-xs text-[var(--color-brand)]">{app.url}</span>
      )}
    </Link>
  );
}

export function AppsPage() {
  const { data: apps, isLoading, error } = useApps();
  const [mode, setMode] = useState<Mode>("open");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My Apps</h1>
        <div className="flex items-center gap-3">
          {apps && (
            <span className="text-sm text-[var(--color-muted)]">
              {apps.length} {apps.length === 1 ? "app" : "apps"}
            </span>
          )}
          <div className="flex items-center gap-0.5 rounded-lg bg-[var(--color-surface-2)] p-1 text-xs">
            <button
              onClick={() => setMode("open")}
              className={`rounded px-2.5 py-1 transition-colors ${
                mode === "open"
                  ? "bg-[var(--color-bg)] text-white shadow-sm"
                  : "text-[var(--color-muted)] hover:text-white"
              }`}
            >
              Open
            </button>
            <button
              onClick={() => setMode("details")}
              className={`rounded px-2.5 py-1 transition-colors ${
                mode === "details"
                  ? "bg-[var(--color-bg)] text-white shadow-sm"
                  : "text-[var(--color-muted)] hover:text-white"
              }`}
            >
              Details
            </button>
          </div>
        </div>
      </div>

      {isLoading && <LoadingBlock label="Loading apps…" />}
      {error && <InlineError message={(error as Error).message} />}

      {apps && apps.length === 0 && (
        <EmptyState title="No apps yet">
          Create one from your machine with{" "}
          <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs">
            vibe init
          </code>{" "}
          and{" "}
          <code className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs">
            vibe deploy
          </code>
          , or describe one in <Link to="/chat" className="text-[var(--color-brand)]">Chat</Link>.
        </EmptyState>
      )}

      {apps && apps.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((a) => (
            <AppCard key={a.id} app={a} mode={mode} />
          ))}
        </div>
      )}
    </div>
  );
}
