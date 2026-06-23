import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AppSummary, JobKind } from "@vibe/shared";
import { classNames } from "../lib/format";
import { useSettings } from "../lib/queries";
import { Toggle } from "./ui";

const KINDS: { value: JobKind; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Read-only — answers from your live data. No edits." },
  { value: "build", label: "Build", hint: "Creates a brand-new app on your machine." },
  { value: "adjust", label: "Adjust", hint: "Edits an existing app on your machine." },
];

export function Composer({
  apps,
  defaultTargetApp,
  sending,
  onSend,
}: {
  apps: AppSummary[];
  defaultTargetApp: string | null;
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
  const [kind, setKind] = useState<JobKind>("ask");
  const [appId, setAppId] = useState(defaultTargetApp ?? "");
  const [newAppId, setNewAppId] = useState("");
  const [plan, setPlan] = useState(false);
  const planTouched = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Seed the plan toggle from the saved default until the user flips it.
  useEffect(() => {
    if (settings && !planTouched.current) setPlan(settings.planModeDefault);
  }, [settings]);

  const targetApp = kind === "build" ? newAppId.trim() : appId || null;
  const needsTarget = kind === "build" || kind === "adjust";
  const canSend = !!text.trim() && !sending && !(needsTarget && !targetApp);
  const meta = KINDS.find((k) => k.value === kind)!;
  const policyActive = needsTarget && !!settings?.stackPolicy.trim();

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), kind, targetApp || null, plan);
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  return (
    <div
      className="sticky bottom-0 z-10 border-t border-[var(--color-border)] bg-[var(--color-bg)] pt-3"
      style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
    >
      {/* Kind segmented control + plan toggle */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex w-full rounded-lg border border-[var(--color-border-strong)] p-0.5 text-sm sm:w-auto">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={classNames(
                "flex-1 rounded-md px-3 py-1.5 font-medium transition-colors sm:flex-none",
                kind === k.value
                  ? "bg-[var(--color-brand-soft)] text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
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

      <p className="mb-2 text-xs text-[var(--color-muted)]">
        {meta.hint}
        {needsTarget && !plan && (
          <span className="text-[var(--color-faint)]">
            {" "}
            Runs the selected local agent with edits + shell in the app's directory on your machine.
          </span>
        )}
        {plan && (
          <span className="text-[var(--color-warn)]">
            {" "}
            Plan mode: the agent proposes a plan instead of editing/executing — turn
            off to run it.
          </span>
        )}
      </p>

      {policyActive && (
        <p className="mb-2 text-xs text-[var(--color-faint)]">
          <span className="pill mr-1 bg-[var(--color-surface-2)] text-[var(--color-muted)]">
            ⚙ stack policy active
          </span>
          <Link to="/settings" className="text-[var(--color-brand)]">
            edit
          </Link>
        </p>
      )}

      {/* Target selector */}
      <div className="mb-2">
        {kind === "build" ? (
          <input
            className="input"
            placeholder="new app id, e.g. my-lists"
            value={newAppId}
            onChange={(e) => setNewAppId(e.target.value)}
          />
        ) : (
          <select
            className="input"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          >
            <option value="">{kind === "adjust" ? "— pick an app to edit —" : "(no specific app)"}</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Message + send */}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          className="input max-h-40 min-h-[44px] resize-none py-2.5"
          rows={1}
          placeholder="Ask about your data, or describe a change…  (Enter to send, Shift+Enter for newline)"
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
