import { useEffect, useState } from "react";
import type { LlmProvider } from "@vibe/shared";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { Card, Toggle } from "../components/ui";
import { InlineError, LoadingBlock } from "../components/States";

const MODEL_PRESETS: Record<LlmProvider, string[]> = {
  claude: ["sonnet", "opus"],
  codex: ["gpt-5", "gpt-5.1", "gpt-5.4", "gpt-5.5"],
};

export function SettingsPage() {
  const { data: settings, isLoading, error } = useSettings();
  const update = useUpdateSettings();

  const [stackPolicy, setStackPolicy] = useState("");
  const [planModeDefault, setPlanModeDefault] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("claude");
  const [llmModel, setLlmModel] = useState("sonnet");
  const [savedAt, setSavedAt] = useState(0);

  // Seed local form state once settings load.
  useEffect(() => {
    if (settings) {
      setStackPolicy(settings.stackPolicy);
      setPlanModeDefault(settings.planModeDefault);
      setLlmProvider(settings.llmProvider);
      setLlmModel(settings.llmModel);
    }
  }, [settings]);

  const dirty =
    !!settings &&
    (stackPolicy !== settings.stackPolicy ||
      planModeDefault !== settings.planModeDefault ||
      llmProvider !== settings.llmProvider ||
      llmModel !== settings.llmModel);

  const save = () =>
    update.mutate(
      { stackPolicy, planModeDefault, llmProvider, llmModel },
      { onSuccess: () => setSavedAt(Date.now()) }
    );

  if (isLoading) return <LoadingBlock label="Loading settings…" />;
  if (error) return <InlineError message={(error as Error).message} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Defaults the chat applies when it runs a local LLM on your machine.
        </p>
      </div>

      <Card title="LLM runner">
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Pick which local coding agent the daemon runs for new chat jobs. Model
          values are passed through to the provider CLI, so custom aliases work.
        </p>
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              Provider
            </span>
            <select
              className="input"
              value={llmProvider}
              onChange={(e) => {
                const provider = e.target.value as LlmProvider;
                setLlmProvider(provider);
                setLlmModel(MODEL_PRESETS[provider][0] ?? "");
              }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex / ChatGPT</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              Model
            </span>
            <input
              className="input"
              list="llm-model-presets"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder={llmProvider === "claude" ? "sonnet" : "gpt-5"}
            />
            <datalist id="llm-model-presets">
              {MODEL_PRESETS[llmProvider].map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
        </div>
      </Card>

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
              In plan mode the agent researches and proposes a plan instead of
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
        <button
          className="btn-primary"
          disabled={!dirty || update.isPending || !llmModel.trim()}
          onClick={save}
        >
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
