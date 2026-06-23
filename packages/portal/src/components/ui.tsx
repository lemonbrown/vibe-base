import { useEffect, useRef, useState } from "react";
import type { Health } from "@vibe/shared";
import { classNames } from "../lib/format";

export function HealthBadge({ health }: { health: Health }) {
  const map: Record<Health, { label: string; color: string }> = {
    healthy: { label: "healthy", color: "var(--color-ok)" },
    unhealthy: { label: "unhealthy", color: "var(--color-bad)" },
    unknown: { label: "unknown", color: "var(--color-warn)" },
  };
  const m = map[health] ?? map.unknown;
  return (
    <span className="pill" style={{ color: m.color }}>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: m.color }}
        aria-hidden
      />
      {m.label}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const muted = ["archived", "registered"].includes(status);
  return (
    <span
      className={classNames(
        "pill",
        muted ? "text-[var(--color-muted)]" : "text-[var(--color-text)]"
      )}
    >
      {status}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={classNames("card p-4 sm:p-5", className)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="section-title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Accessible on/off switch. */
export function Toggle({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={classNames(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-[var(--color-brand)]" : "bg-[var(--color-border-strong)]"
      )}
    >
      <span
        className={classNames(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-5" : "translate-x-1"
        )}
      />
    </button>
  );
}

/**
 * A button that arms on first click and fires on the second, so destructive
 * actions (revoke, roll back) need a deliberate confirm without a modal.
 */
export function ConfirmButton({
  children,
  confirmLabel = "Confirm?",
  onConfirm,
  variant = "danger",
  disabled,
}: {
  children: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  variant?: "danger" | "ghost";
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const cls = variant === "danger" ? "btn-danger" : "btn-ghost";
  return (
    <button
      type="button"
      className={armed ? "btn-danger" : cls}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          window.clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), 3500);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
