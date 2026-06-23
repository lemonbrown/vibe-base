import { useEffect, useState } from "react";
import type { LlmProvider } from "@vibe/shared";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { Card, Toggle } from "../components/ui";
import { InlineError, LoadingBlock } from "../components/States";

const MODEL_PRESETS: Record<LlmProvider, string[]> = {
  claude: [
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-haiku-4-5-20251001",
  ],
  codex: [
    "o4-mini",
    "o3",
    "o3-mini",
    "o1",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ],
};

const REASONING_MODELS = new Set(["o4-mini", "o3", "o3-mini", "o1", "o1-mini", "o3-pro"]);

function isReasoningModel(model: string): boolean {
  // o-series models start with "o" followed by a digit
  return REASONING_MODELS.has(model) || /^o\d/.test(model);
}

export function SettingsPage() {
  const { data: settings, isLoading, error } = useSettings();
  const update = useUpdateSettings();

  const [stackPolicy, setStackPolicy] = useState("");
  const [planModeDefault, setPlanModeDefault] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("claude");
  const [llmModel, setLlmModel] = useState("claude-sonnet-4-6");
  const [llmReasoningEffort, setLlmReasoningEffort] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Seed local form state once settings load.
  useEffect(() => {
    if (settings) {
      setStackPolicy(settings.stackPolicy);
      setPlanModeDefault(settings.planModeDefault);
      setLlmProvider(settings.llmProvider);
      setLlmModel(settings.llmModel);
      setLlmReasoningEffort(settings.llmReasoningEffort);
    }
  }, [settings]);

  const dirty =
    !!settings &&
    (stackPolicy !== settings.stackPolicy ||
      planModeDefault !== settings.planModeDefault ||
      llmProvider !== settings.llmProvider ||
      llmModel !== settings.llmModel ||
      llmReasoningEffort !== settings.llmReasoningEffort);

  const save = () =>
    update.mutate(
      { stackPolicy, planModeDefault, llmProvider, llmModel, llmReasoningEffort },
      { onSuccess: () => setSavedAt(Date.now()) }
    );

  const showReasoningEffort = llmProvider === "codex" && isReasoningModel(llmModel);

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
                setLlmReasoningEffort(null);
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
              onChange={(e) => {
                setLlmModel(e.target.value);
                if (!isReasoningModel(e.target.value)) setLlmReasoningEffort(null);
              }}
              placeholder={llmProvider === "claude" ? "claude-sonnet-4-6" : "o4-mini"}
            />
            <datalist id="llm-model-presets">
              {MODEL_PRESETS[llmProvider].map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
        </div>

        {showReasoningEffort && (
          <div className="mt-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
                Reasoning effort
              </span>
              <select
                className="input"
                value={llmReasoningEffort ?? ""}
                onChange={(e) => setLlmReasoningEffort(e.target.value || null)}
              >
                <option value="">Default</option>
                <option value="low">Low — fast, lighter reasoning</option>
                <option value="medium">Medium</option>
                <option value="high">High — slower, deeper reasoning</option>
              </select>
            </label>
            <p className="mt-1 text-xs text-[var(--color-faint)]">
              Controls how much the model "thinks" before responding. Only applies to o-series models.
            </p>
          </div>
        )}
      </Card>

      <Card title="Stack policy">
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Free-text preferences injected into every chat so you don't have to repeat them.
          The model reads this as guidance on tech choices, conventions, and constraints.
        </p>
        <textarea
          className="input min-h-[120px] resize-y font-mono text-[13px] leading-relaxed"
          placeholder={"e.g. Use Bun, React, TypeScript, Vite and Tailwind.\nPrefer server components. Write tests with Vitest."}
          value={stackPolicy}
          onChange={(e) => setStackPolicy(e.target.value)}
        />
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
