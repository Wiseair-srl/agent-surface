import { useEffect, useMemo, useRef, useState } from "react";
import { createAgentToolset } from "@agent-surface/core";
import type { App } from "../agent/setup.js";
import { runDevicesScenario, type AgentTranscriptEntry } from "../agent/scripted-agent.js";
import { runLlmAgent } from "../agent/llm-agent.js";
import { Transcript, type TranscriptEntry } from "./Transcript.js";

/**
 * The agent console: two drivers over the SAME embedded toolset — a scripted
 * fake model (CI-safe, docs/14 M10) and an optional real model via OpenRouter.
 * Steps render as a compact timeline; the raw payloads are one click away.
 * Step mode parks the agent before each call so the surface change from the
 * previous one is visible in the app next door.
 */

const KEY_STORAGE = "devices-app.openrouter-key";
const SCENARIO_PROMPT =
  "Show me the offline devices in Milano, select the visible ones and disable them. Then remove the filter.";

export function DevPanel(props: { app: App }) {
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [surfaceVersion, setSurfaceVersion] = useState(props.app.registry.getVersion());
  const [apiKey, setApiKey] = useState<string>(
    () =>
      (import.meta.env?.VITE_OPENROUTER_API_KEY as string | undefined) ??
      localStorage.getItem(KEY_STORAGE) ??
      "",
  );
  const [rememberKey, setRememberKey] = useState<boolean>(
    () => localStorage.getItem(KEY_STORAGE) !== null,
  );
  const [model, setModel] = useState("anthropic/claude-sonnet-4.5");
  const [prompt, setPrompt] = useState(SCENARIO_PROMPT);
  const [stepMode, setStepMode] = useState(false);
  /** Set while the agent is parked before a step; resolving it lets it run. */
  const [pendingStep, setPendingStep] = useState<{ step: string; tool: string } | null>(null);
  const releaseStepRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const toolset = useMemo(
    () =>
      createAgentToolset(props.app.registry, {
        consumer: { id: "dev-panel", kind: "embedded" },
        confirmations: "wait",
      }),
    [props.app],
  );

  useEffect(
    () =>
      props.app.registry.subscribe((event) => {
        if (event.type === "surface-changed") setSurfaceVersion(event.surfaceVersion);
      }),
    [props.app],
  );

  useEffect(() => {
    const node = transcriptRef.current?.querySelector(".transcript");
    node?.scrollTo({ top: node.scrollHeight });
  }, [entries]);

  const push = (entry: TranscriptEntry): void => setEntries((prev) => [...prev, entry]);
  /** Completes the last pending call card in place. */
  const settleLast = (patch: Partial<TranscriptEntry>): void =>
    setEntries((prev) => {
      const index = [...prev].reverse().findIndex((e) => e.kind === "call" && e.status === "pending");
      if (index === -1) return prev;
      const at = prev.length - 1 - index;
      const next = [...prev];
      next[at] = { ...(next[at] as TranscriptEntry), ...patch } as TranscriptEntry;
      return next;
    });

  const persistKey = (value: string, remember: boolean): void => {
    setApiKey(value);
    setRememberKey(remember);
    if (remember && value) localStorage.setItem(KEY_STORAGE, value);
    else localStorage.removeItem(KEY_STORAGE);
  };

  const start = (): boolean => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setRunning(true);
    setEntries([]);
    return true;
  };
  const finish = (): void => {
    runningRef.current = false;
    setRunning(false);
  };

  const runScripted = async (): Promise<void> => {
    if (!start()) return;
    push({ kind: "user", text: SCENARIO_PROMPT });
    try {
      const outcome = await runDevicesScenario(toolset, {
        city: "Milano",
        // Step mode parks the agent before every call so the surface change
        // from the previous one is visible in the app next door.
        ...(stepMode
          ? {
              gate: (step: string, tool: string) =>
                new Promise<void>((resolve) => {
                  setPendingStep({ step, tool });
                  releaseStepRef.current = () => {
                    setPendingStep(null);
                    releaseStepRef.current = null;
                    resolve();
                  };
                }),
            }
          : {}),
        onStep: (entry: AgentTranscriptEntry) =>
          push(
            entry.result.status === "ok"
              ? {
                  kind: "call",
                  tool: entry.tool,
                  args: entry.input,
                  status: "ok",
                  ...(entry.result.output !== undefined ? { output: entry.result.output } : {}),
                }
              : {
                  kind: "call",
                  tool: entry.tool,
                  args: entry.input,
                  status: "error",
                  error: entry.result.error,
                },
          ),
      });
      push({
        kind: "note",
        text:
          outcome.disabled > 0
            ? `Finished — disabled ${outcome.disabled} device(s): ${outcome.selectedIds.join(", ")}, filter cleared`
            : "Finished — nothing to disable, filter cleared",
      });
    } catch (err) {
      push({
        kind: "note",
        text: `Stopped: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPendingStep(null);
      releaseStepRef.current = null;
      finish();
    }
  };

  const runLive = async (): Promise<void> => {
    if (!apiKey || !start()) return;
    persistKey(apiKey, rememberKey);
    try {
      await runLlmAgent(toolset, {
        apiKey,
        model,
        prompt,
        onEvent: (event) => {
          switch (event.kind) {
            case "user":
              push({ kind: "user", text: event.text });
              break;
            case "assistant":
              push({ kind: "assistant", text: event.text });
              break;
            case "tool-call":
              push({ kind: "call", tool: event.tool, args: event.args, status: "pending" });
              break;
            case "tool-result":
              settleLast(
                event.ok
                  ? { status: "ok", ...(event.output !== undefined ? { output: event.output } : {}) }
                  : { status: "error", ...(event.error ? { error: event.error } : {}) },
              );
              break;
            case "error":
              push({ kind: "note", text: event.message });
              break;
            case "done":
              push({ kind: "note", text: `Finished in ${event.turns} turn(s)` });
              break;
          }
        },
      });
    } finally {
      finish();
    }
  };

  return (
    <aside className="console" aria-label="Agent console" ref={transcriptRef}>
      <div className="console-head">
        <span className={`console-dot${running ? " running" : ""}`} />
        <span className="console-title">Agent console</span>
        <span className="console-meta">
          <span data-testid="tool-count">{toolset.tools().length}</span> tools · surface v
          {surfaceVersion}
        </span>
      </div>

      <div className="console-tabs" role="tablist">
        <button role="tab" aria-selected={mode === "scripted"} onClick={() => setMode("scripted")}>
          Scripted
        </button>
        <button role="tab" aria-selected={mode === "llm"} onClick={() => setMode("llm")}>
          Live LLM
        </button>
      </div>

      <div className="console-body">
        {mode === "scripted" ? (
          <>
            <p className="console-intent">“{SCENARIO_PROMPT}”</p>
            <div className="console-row">
              <button
                className="btn-accent"
                data-testid="run-agent"
                disabled={running}
                onClick={() => void runScripted()}
              >
                {running ? "Running…" : stepMode ? "Run step by step" : "Run scenario"}
              </button>
              <label className="mode-toggle">
                <input
                  type="checkbox"
                  checked={stepMode}
                  disabled={running}
                  onChange={(e) => setStepMode(e.target.checked)}
                />
                step by step
              </label>
              <span className="console-note">deterministic, no LLM — the CI path</span>
            </div>
            {pendingStep && (
              <div className="stepper" data-testid="stepper">
                <span className="stepper-label">
                  next: {pendingStep.step} — <b>{pendingStep.tool}</b>
                </span>
                <button
                  className="btn-accent"
                  data-testid="next-step"
                  onClick={() => releaseStepRef.current?.()}
                >
                  Run this step
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="console-field">
              <label htmlFor="llm-key">OpenRouter API key</label>
              <input
                id="llm-key"
                className="console-input"
                type="password"
                placeholder="sk-or-…"
                value={apiKey}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="console-row">
              <label className="remember">
                <input
                  type="checkbox"
                  checked={rememberKey}
                  onChange={(e) => persistKey(apiKey, e.target.checked)}
                />
                remember in this browser
              </label>
              <span className="console-note" style={{ marginLeft: "auto" }}>
                sent only to{" "}
                <a href="https://openrouter.ai" target="_blank" rel="noreferrer">
                  openrouter.ai
                </a>
              </span>
            </div>
            <div className="console-field">
              <label htmlFor="llm-model">Model</label>
              <input
                id="llm-model"
                className="console-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="console-field">
              <label htmlFor="llm-prompt">Task</label>
              <textarea
                id="llm-prompt"
                className="console-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="console-row">
              <button
                className="btn-accent"
                data-testid="run-llm"
                disabled={running || !apiKey}
                onClick={() => void runLive()}
              >
                {running ? "Running…" : "Run with live model"}
              </button>
              <span className="console-note">tool-calling loop over the same catalog</span>
            </div>
          </>
        )}

        <Transcript entries={entries} />
      </div>
    </aside>
  );
}
