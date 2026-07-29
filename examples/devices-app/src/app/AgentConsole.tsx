import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { createAgentToolset } from "@agent-surface/core";
import type { App } from "../agent/setup.js";
import { runDevicesScenario, type AgentTranscriptEntry } from "../agent/scripted-agent.js";
import { runLlmAgent } from "../agent/llm-agent.js";
import {
  AgentComposer,
  AgentThread,
  convertEntry,
  type StoredEntry,
  type TranscriptEntry,
} from "./AgentThread.js";
import { describeTool } from "./ToolCall.js";

/**
 * The agent console: two drivers over the SAME embedded toolset — a scripted
 * fake model (CI-safe, docs/14 M10) and an optional real model via OpenRouter.
 *
 * It floats OVER the app rather than taking a column out of the route: the app
 * is the product, the console is an instrument pointed at it. That matters most
 * in step mode, where the whole point is watching the surface change underneath
 * between calls — so the panel is a non-modal companion (no backdrop, no focus
 * trap), anchored to a corner, and collapsible to a launcher that still lets you
 * advance the agent one step at a time.
 *
 * The chat itself is assistant-ui: this component owns the messages and both
 * run loops, so it exposes them through an external-store runtime rather than
 * letting the library drive a model. agent-surface stays the thing that turns
 * the page into tools; assistant-ui is the thread around it.
 */

const KEY_STORAGE = "devices-app.openrouter-key";
const SCENARIO_PROMPT =
  "Show me the offline devices in Milano, select the visible ones and disable them. Then remove the filter.";

/** What the agent is parked on, waiting for the user to release it. */
interface PendingStep {
  /** Human description from the script ("disable the selection"). */
  step: string;
  /** Wire name, e.g. `domain_devices__disable`. */
  tool: string;
  /** 1-based position in the run so far. */
  index: number;
}

type StepAction = "step" | "all" | "stop";

/** Collapsed state: a launcher that still carries the run's status. */
function ConsoleLauncher(props: {
  running: boolean;
  pendingStep: PendingStep | null;
  toolCount: number;
  onOpen: () => void;
  onRunStep: () => void;
}) {
  const { pendingStep } = props;
  return (
    <div className="console-launcher-dock">
      {pendingStep && (
        <div className="launcher-step" role="status">
          <span className="launcher-step-label">
            paused before <b>{describeTool(pendingStep.tool).id}</b>
          </span>
          <button className="btn-accent btn-sm" data-testid="next-step-mini" onClick={props.onRunStep}>
            Run step
          </button>
        </div>
      )}
      <button
        className="console-launcher"
        data-testid="console-launcher"
        onClick={props.onOpen}
        aria-label="Open the agent console"
      >
        <span
          className={`console-dot${pendingStep ? " parked" : props.running ? " running" : ""}`}
        />
        <span className="console-launcher-text">Agent console</span>
        <span className="console-launcher-meta">{props.toolCount} tools</span>
      </button>
    </div>
  );
}

/**
 * The step-by-step runner. It reads as the live head of the transcript above
 * it: same plane chip + capability id grammar as a settled row, so the eye
 * tracks one column. The plane is the point — `domain` is authoritative and
 * will stop for confirmation, `view` only moves what you can see — so it is
 * stated in words, not just colour.
 */
function Stepper(props: {
  pendingStep: PendingStep;
  onAction: (action: StepAction) => void;
}) {
  const { pendingStep } = props;
  const { plane, id, instance } = describeTool(pendingStep.tool);
  const runRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to the action as soon as the agent parks: the run becomes
  // Enter-to-advance, and screen readers land on what to do next.
  useEffect(() => {
    runRef.current?.focus();
  }, [pendingStep.index]);

  return (
    <div className={`stepper plane-${plane}`} data-testid="stepper" role="status">
      <div className="stepper-head">
        <span className="stepper-kicker">next call</span>
        <span className="stepper-count">step {pendingStep.index}</span>
      </div>

      <div className="stepper-id">
        <span className={`step-plane ${plane}`}>{plane}</span>
        <code className="stepper-tool">
          {id}
          {instance && <span className="step-instance">@{instance}</span>}
        </code>
      </div>

      <p className="stepper-desc">{pendingStep.step}</p>
      <p className="stepper-why">
        {plane === "domain"
          ? "authoritative — the server executes, and it will ask you to approve first"
          : "presentation only — moves what the page shows, nothing is written"}
      </p>

      <div className="stepper-actions">
        <button
          className="btn-accent"
          data-testid="next-step"
          ref={runRef}
          onClick={() => props.onAction("step")}
        >
          Run step <kbd>↵</kbd>
        </button>
        <button className="btn-ghost btn-sm" data-testid="run-rest" onClick={() => props.onAction("all")}>
          Run the rest
        </button>
        <button className="btn-quiet" data-testid="stop-run" onClick={() => props.onAction("stop")}>
          Stop
        </button>
      </div>
    </div>
  );
}

export function AgentConsole(props: { app: App }) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [entries, setEntries] = useState<StoredEntry[]>([]);
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
  const [stepMode, setStepMode] = useState(false);
  /** Set while the agent is parked before a step; resolving it lets it run. */
  const [pendingStep, setPendingStep] = useState<PendingStep | null>(null);
  const releaseStepRef = useRef<((action: StepAction) => void) | null>(null);
  /** Flipped by "Run the rest": later gates resolve without parking. */
  const skipGateRef = useRef(false);
  /** 1-based position of the parked call within the current run. */
  const stepCounterRef = useRef(0);
  const runningRef = useRef(false);
  const entryIdRef = useRef(0);

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

  const push = (entry: TranscriptEntry): void => {
    entryIdRef.current += 1;
    const stored = { ...entry, id: `entry_${entryIdRef.current}` } as StoredEntry;
    setEntries((prev) => [...prev, stored]);
  };
  /** Completes the last pending call card in place. */
  const settleLast = (patch: Partial<TranscriptEntry>): void =>
    setEntries((prev) => {
      const index = [...prev].reverse().findIndex((e) => e.kind === "call" && e.status === "pending");
      if (index === -1) return prev;
      const at = prev.length - 1 - index;
      const next = [...prev];
      next[at] = { ...(next[at] as StoredEntry), ...patch } as StoredEntry;
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
    skipGateRef.current = false;
    stepCounterRef.current = 0;
    setRunning(true);
    setEntries([]);
    return true;
  };
  const finish = (): void => {
    runningRef.current = false;
    setRunning(false);
  };

  /**
   * Parks the agent before a call. "Run the rest" resolves this one and marks
   * every later gate as open; "Stop" rejects, which unwinds the scenario the
   * same way any failed call would — the script needs no cancellation path.
   */
  const gate = (step: string, tool: string): Promise<void> => {
    if (skipGateRef.current) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      stepCounterRef.current += 1;
      setPendingStep({ step, tool, index: stepCounterRef.current });
      releaseStepRef.current = (action) => {
        setPendingStep(null);
        releaseStepRef.current = null;
        if (action === "all") skipGateRef.current = true;
        if (action === "stop") reject(new Error("stopped before this step"));
        else resolve();
      };
    });
  };

  const runScripted = async (): Promise<void> => {
    if (!start()) return;
    push({ kind: "user", text: SCENARIO_PROMPT });
    try {
      const outcome = await runDevicesScenario(toolset, {
        city: "Milano",
        // Step mode parks the agent before every call so the surface change
        // from the previous one is visible in the app underneath.
        ...(stepMode ? { gate } : {}),
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

  const runLive = async (prompt: string): Promise<void> => {
    if (!apiKey || !prompt.trim() || !start()) return;
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

  /**
   * The store is external because the run loops are ours: assistant-ui renders
   * and drives the composer, agent-surface executes. Submitting from the
   * composer starts a live run; the agent's own events append to `entries`.
   */
  const runtime = useExternalStoreRuntime({
    isRunning: running,
    messages: entries,
    convertMessage: convertEntry,
    onNew: async (message: AppendMessage) => {
      const part = message.content[0];
      if (part?.type !== "text") return;
      await runLive(part.text);
    },
  });

  if (!open) {
    return (
      <ConsoleLauncher
        running={running}
        pendingStep={pendingStep}
        toolCount={toolset.tools().length}
        onOpen={() => setOpen(true)}
        onRunStep={() => releaseStepRef.current?.("step")}
      />
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside className="console" role="complementary" aria-label="Agent console">
          <div className="console-head">
          <span
            className={`console-dot${pendingStep ? " parked" : running ? " running" : ""}`}
          />
          <span className="console-title">Agent console</span>
          <span className="console-meta">
            <span data-testid="tool-count">{toolset.tools().length}</span> tools · surface v
            {surfaceVersion}
          </span>
          <button
            className="console-collapse"
            data-testid="console-collapse"
            onClick={() => setOpen(false)}
            aria-label="Collapse the agent console"
            title="Collapse"
          >
            {/* an SVG, not a "⌄" glyph: text chevrons carry their own vertical
                bearing and never optically centre in a square button */}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M4 6.5 L8 10.5 L12 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="console-tabs" role="tablist">
          <button role="tab" aria-selected={mode === "scripted"} onClick={() => setMode("scripted")}>
            Scripted
          </button>
          <button role="tab" aria-selected={mode === "llm"} onClick={() => setMode("llm")}>
            Live LLM
          </button>
        </div>


        <AgentThread
          empty={
            mode === "scripted"
              ? "Run the scenario and every tool call it makes against this page lands here."
              : "Give the model a task. Every tool call it makes against this page lands here."
          }
          composer={
            <div className="console-composer">
              {pendingStep ? (
                <Stepper
                  pendingStep={pendingStep}
                  onAction={(action) => releaseStepRef.current?.(action)}
                />
              ) : mode === "scripted" ? (
                <>
                  <p className="composer-intent">“{SCENARIO_PROMPT}”</p>
                  <div className="composer-actions">
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
                        aria-label="Step by step"
                        checked={stepMode}
                        disabled={running}
                        onChange={(e) => setStepMode(e.target.checked)}
                      />
                      step by step
                    </label>
                    <span className="console-note">deterministic, no LLM — the CI path</span>
                  </div>
                </>
              ) : (
                <>
                  <details className="composer-settings" open={!apiKey}>
                    <summary>
                      Connection
                      <span className="composer-settings-state">
                        {apiKey ? `key set · ${model}` : "no API key yet"}
                      </span>
                    </summary>
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
                  </details>

                  <AgentComposer disabled={!apiKey || running} running={running} />
                  <span className="console-note">tool-calling loop over the same catalog</span>
                </>
              )}
            </div>
          }
        />
      </aside>
    </AssistantRuntimeProvider>
  );
}
