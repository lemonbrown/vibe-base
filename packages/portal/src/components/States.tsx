import { useRouteError } from "react-router-dom";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-brand)] ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-[var(--color-muted)]">
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-base font-medium">{title}</p>
      {children && (
        <div className="max-w-md text-sm text-[var(--color-muted)]">{children}</div>
      )}
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[#5a2730] bg-[#1c0f12] px-3 py-2 text-sm text-[var(--color-bad)]">
      {message}
    </div>
  );
}

/** Router error boundary. */
export function ErrorState() {
  const err = useRouteError() as { message?: string; statusText?: string } | undefined;
  const msg = err?.message ?? err?.statusText ?? "Something went wrong.";
  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <h1 className="mb-2 text-lg font-semibold">Something broke</h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">{msg}</p>
      <a href="/" className="btn-primary">
        Back to apps
      </a>
    </div>
  );
}
