import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatAttachment, JobKind } from "@vibe/shared";
import { useSettings } from "../lib/queries";
import { attachmentSummary, processFiles, type AttachmentDraft } from "../lib/attachments";
import { Toggle } from "./ui";

export function Composer({
  sending,
  streaming,
  stopping,
  onSend,
  onStop,
}: {
  sending: boolean;
  streaming?: boolean;
  stopping?: boolean;
  onSend: (
    content: string,
    kind: JobKind,
    targetApp: string | null,
    planMode: boolean,
    attachments: ChatAttachment[]
  ) => void;
  onStop?: () => void;
}) {
  const { data: settings } = useSettings();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [processing, setProcessing] = useState(false);
  const planTouched = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Seed the plan toggle from the saved default until the user flips it.
  useEffect(() => {
    if (settings && !planTouched.current) setPlan(settings.planModeDefault);
  }, [settings]);

  const readyAttachments = attachments.filter((a) => a.status === "ready");
  const canSend =
    (!!text.trim() || readyAttachments.length > 0) &&
    !sending &&
    !streaming &&
    !processing &&
    readyAttachments.length === attachments.length;
  const policyActive = !!settings?.stackPolicy.trim();

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setProcessing(true);
    try {
      const processed = await processFiles(files, attachments.length);
      setAttachments((cur) => [...cur, ...processed]);
    } finally {
      setProcessing(false);
    }
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void addFilesRef.current(files);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), "chat", null, plan, readyAttachments);
    setText("");
    setAttachments([]);
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

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <span
              key={att.id}
              className={
                att.status === "error"
                  ? "inline-flex max-w-full items-center gap-2 rounded-lg border border-[#5a2730] bg-[#1c0f12] px-2.5 py-1 text-xs text-[var(--color-bad)]"
                  : "inline-flex max-w-full items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-[var(--color-muted)]"
              }
              title={att.status === "error" ? att.error : attachmentSummary(att)}
            >
              <span className="truncate">
                {att.status === "error" ? `${att.name}: ${att.error}` : attachmentSummary(att)}
              </span>
              <button
                aria-label={`Remove ${att.name}`}
                className="text-[var(--color-faint)] hover:text-[var(--color-text)]"
                type="button"
                onClick={() => setAttachments((cur) => cur.filter((a) => a.id !== att.id))}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Message + send */}
      <div
        className="flex items-end gap-2"
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/*,application/pdf"
          multiple
          onChange={(e) => {
            void addFiles(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = "";
          }}
        />
        <button
          className="btn-ghost h-11 w-11 px-0"
          type="button"
          title="Attach image or PDF"
          disabled={sending || !!streaming || processing}
          onClick={() => fileRef.current?.click()}
        >
          +
        </button>
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
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) void addFiles(files);
          }}
        />
        {streaming && onStop ? (
          <button
            className="h-11 px-5 rounded-xl border border-[var(--color-bad)] text-[var(--color-bad)] text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="btn-primary h-11 px-5" disabled={!canSend} onClick={submit}>
            {sending ? "…" : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}
