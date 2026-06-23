import { useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { Card, Toggle } from "../components/ui";
import { InlineError, LoadingBlock } from "../components/States";

export function SettingsPage() {
  const { data: settings, isLoading, error } = useSettings();
  const update = useUpdateSettings();

  const [stackPolicy, setStackPolicy] = useState("");
  const [planModeDefault, setPlanModeDefault] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  // Seed local form state once settings load.
  useEffect(() => {
    if (settings) {
      setStackPolicy(settings.stackPolicy);
      setPlanModeDefault(settings.planModeDefault);
    }
  }, [settings]);

  const dirty =
    !!settings &&
    (stackPolicy !== settings.stackPolicy ||
      planModeDefault !== settings.planModeDefault);

  const save = () =>
    update.mutate(
      { stackPolicy, planModeDefault },
      { onSuccess: () => setSavedAt(Date.now()) }
    );

  if (isLoading) return <LoadingBlock label="Loading settings…" />;
  if (error) return <InlineError message={(error as Error).message} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Defaults the chat applies when it runs Claude on your machine.
        </p>
      </div>

      <Card title="Stack policy">
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Free-text preferences injected into <b>Build</b> and <b>Adjust</b> chats
          so you don't have to repeat them. The model reads this as guidance.
        </p>
        <textarea
          className="input min-h-[120px] resize-y font-mono text-[13px] leading-relaxed"
          placeholder={"e.g. Use Bun, React, TypeScript, Vite and Tailwind.\nPrefer server components. Write tests with Vitest."}
          value={stackPolicy}
          onChange={(e) => setStackPolicy(e.target.value)}
        />
        <p className="mt-2 text-xs text-[var(--color-faint)]">
          Not used for read-only <b>Ask</b> questions.
        </p>
      </Card>

      <Card title="Plan mode">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm">Default new messages to plan mode</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              In plan mode Claude researches and proposes a plan instead of
              editing or executing. You can still flip this per message in the
              chat composer.
            </p>
          </div>
          <Toggle
            checked={planModeDefault}
            onChange={setPlanModeDefault}
            label="Default to plan mode"
          />
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={!dirty || update.isPending} onClick={save}>
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        {update.error && (
          <span className="text-sm text-[var(--color-bad)]">
            {(update.error as Error).message}
          </span>
        )}
        {!update.error && !dirty && savedAt > 0 && (
          <span className="text-sm text-[var(--color-ok)]">Saved.</span>
        )}
      </div>
    </div>
  );
}
