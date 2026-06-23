import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { JobKind } from "@vibe/shared";
import { useSettings } from "../lib/queries";
import { Toggle } from "./ui";

export function Composer({
  sending,
  onSend,
}: {
  sending: boolean;
  onSend: (
    content: string,
    kind: JobKind,
    targetApp: string | null,
    planMode: boolean
  ) => void;
}) {
  const { data: settings } = useSettings();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState(false);
  const planTouched = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Seed the plan toggle from the saved default until the user flips it.
  useEffect(() => {
    if (settings && !planTouched.current) setPlan(settings.planModeDefault);
  }, [settings]);

  const canSend = !!text.trim() && !sending;
  const policyActive = !!settings?.stackPolicy.trim();

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), "chat", null, plan);
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  return (
    <div
      className="sticky bottom-0 z-10 border-t border-[var(--color-border)] bg-[var(--color-bg)] pt-3"
      style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        {policyActive ? (
          <p className="text-xs text-[var(--color-faint)]">
            <span className="pill mr-1 bg-[var(--color-surface-2)] text-[var(--color-muted)]">
              ⚙ stack policy active
            </span>
            <Link to="/settings" className="text-[var(--color-brand)]">
              edit
            </Link>
          </p>
        ) : (
          <span />
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <span className={plan ? "text-[var(--color-text)]" : "text-[var(--color-muted)]"}>
            Plan
          </span>
          <Toggle
            checked={plan}
            label="Plan mode"
            onChange={(v) => {
              planTouched.current = true;
              setPlan(v);
            }}
          />
        </label>
      </div>

      {plan && (
        <p className="mb-2 text-xs text-[var(--color-warn)]">
          Plan mode: the agent proposes a plan instead of editing/executing — turn off to run it.
        </p>
      )}

      {/* Message + send */}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          className="input max-h-40 min-h-[44px] resize-none py-2.5"
          rows={1}
          placeholder="Ask a question, describe a change, or say what to build…  (Enter to send, Shift+Enter for newline)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn-primary h-11 px-5" disabled={!canSend} onClick={submit}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
