import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { createAgentToolset, type AgentConsumer } from "@agent-surface/core";
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
import { ConnectionSettings } from "./ConnectionSettings.js";
import { SurfaceInspector } from "./SurfaceInspector.js";
import { describeTool } from "./ToolCall.js";
import { ChevronDown, Layers, Play, Sliders, Stop } from "./Icons.js";

/**
 * The agent console: two drivers over the SAME embedded toolset — a scripted
 * fake model (CI-safe, docs/14 M10) and an optional real model via OpenRouter.
 *
 * It floats OVER the app rather than taking a column out of the route: the app
 * is the product, the console is an instrument pointed at it. That matters most
 * in step mode, where the whole point is watching the surface change underneath
 * between calls — so the panel is a non-modal companion (no backdrop, no focus
 * trap), anchored to a corner, and collapsible to a launcher that still lets you
 * advance the agent one step at a time. The page reserves its footprint
 * permanently, so it neither reflows the app nor covers it.
 *
 * The chat itself is assistant-ui: this component owns the messages and both
 * run loops, so it exposes them through an external-store runtime rather than
 * letting the library drive a model. agent-surface stays the thing that turns
 * the page into tools; assistant-ui is the thread around it.
 *
 * The panel holds three screens, never two at once — the transcript (what the
 * agent did), the surface (what it could do), and the connection. Anything a
 * run depends on lives on the composer's floor, so there is exactly one place
 * to look before an agent is allowed to touch the page.
 */

const KEY_STORAGE = "devices-app.openrouter-key";
const CONSUMER: AgentConsumer = { id: "dev-panel", kind: "embedded" };
const SCENARIO_PROMPT =
  "Show me the offline devices in Milano, select the visible ones and disable them. Then remove the filter.";

/** Tasks that exercise a different part of the surface than the scenario does. */
const SUGGESTIONS = [
  "Sort the table by city, then open the details of the first offline device.",
  "How many devices are offline in Roma?",
  "Go to the comparison page and filter both tables to offline.",
];

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
type Mode = "scripted" | "llm";
type View = "thread" | "surface" | "settings";

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
    <div className="launcher-dock">
      {pendingStep && (
        <div className="launcher-step" role="status">
          <span className="launcher-step-label">
            paused before <b>{describeTool(pendingStep.tool).id}</b>
          </span>
          <button className="btn btn-primary btn-xs" data-testid="next-step-mini" onClick={props.onRunStep}>
            Run step
          </button>
        </div>
      )}
      <button
        className="launcher"
        data-testid="console-launcher"
        onClick={props.onOpen}
        aria-label="Open the agent console"
      >
        <span
          className={`dot${pendingStep ? " parked" : props.running ? " running" : ""}`}
        />
        <span className="launcher-text">Agent console</span>
        <span className="launcher-meta">{props.toolCount} tools</span>
      </button>
    </div>
  );
}

/**
 * The step gate. It reads as the live head of the trace above it — same plane
 * chip and mono capability id as a settled row — because the decision in front
 * of you is exactly "should this call happen". The plane is the point, so it is
 * stated in words and in the panel's tint, not only in a colour.
 */
function StepGate(props: { pendingStep: PendingStep; onAction: (action: StepAction) => void }) {
  const { pendingStep } = props;
  const { plane, id, instance } = describeTool(pendingStep.tool);
  const runRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to the action as soon as the agent parks: the run becomes
  // Enter-to-advance, and screen readers land on what to do next.
  useEffect(() => {
    runRef.current?.focus();
  }, [pendingStep.index]);

  return (
    <div className={`gate plane-${plane}`} data-testid="stepper" role="status">
      <div className="gate-head">
        <span className="u-kicker">next call</span>
        <span className="gate-count">step {pendingStep.index}</span>
      </div>

      <div className="gate-id">
        <span className={`plane ${plane}`}>{plane}</span>
        <code className="gate-tool">
          {id}
          {instance && <span className="step-instance">@{instance}</span>}
        </code>
      </div>

      <p className="gate-desc">{pendingStep.step}</p>
      <p className="gate-why">
        {plane === "domain"
          ? "Authoritative: the server executes this, and it will ask you to approve first."
          : "Presentation only: it moves what the page shows. Nothing is written."}
      </p>

      <div className="gate-actions">
        <button
          className="btn btn-primary btn-sm"
          data-testid="next-step"
          ref={runRef}
          onClick={() => props.onAction("step")}
        >
          Run step <kbd>↵</kbd>
        </button>
        <button
          className="btn btn-ghost btn-sm"
          data-testid="run-rest"
          onClick={() => props.onAction("all")}
        >
          Run the rest
        </button>
        <button
          className="btn btn-quiet btn-sm"
          data-testid="stop-run"
          onClick={() => props.onAction("stop")}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

export function AgentConsole(props: { app: App }) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<View>("thread");
  const [mode, setMode] = useState<Mode>("scripted");
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
  /** Set by whichever runner can actually be interrupted; null disables Stop. */
  const cancelRef = useRef<(() => void) | null>(null);
  const startedAtRef = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);

  const toolset = useMemo(
    () =>
      createAgentToolset(props.app.registry, {
        consumer: CONSUMER,
        // Embedded loop topology ⇒ confirmations default to "wait" (D26).
        topology: "embedded",
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

  // ⌘I / Ctrl+I toggles the console — the app stays usable either way, so the
  // shortcut is about getting the instrument out of the way and back again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    startedAtRef.current = Date.now();
    setRunning(true);
    setEntries([]);
    setView("thread");
    return true;
  };
  const finish = (): void => {
    runningRef.current = false;
    cancelRef.current = null;
    setRunning(false);
  };
  const elapsed = (): string => `${((Date.now() - startedAtRef.current) / 1000).toFixed(1)}s`;

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
    if (stepMode) cancelRef.current = () => releaseStepRef.current?.("stop");
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
            ? `Disabled ${outcome.disabled} device${outcome.disabled === 1 ? "" : "s"} · filter cleared · ${elapsed()}`
            : `Nothing to disable · filter cleared · ${elapsed()}`,
      });
    } catch (err) {
      push({
        kind: "note",
        tone: "error",
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
    const controller = new AbortController();
    cancelRef.current = () => controller.abort();
    try {
      await runLlmAgent(toolset, {
        apiKey,
        model,
        prompt,
        signal: controller.signal,
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
              push({
                kind: "note",
                tone: "error",
                text: controller.signal.aborted ? "Stopped." : event.message,
              });
              break;
            case "done":
              push({
                kind: "note",
                text: `Finished in ${event.turns} turn${event.turns === 1 ? "" : "s"} · ${elapsed()}`,
              });
              break;
          }
        },
      });
    } finally {
      finish();
    }
  };

  const stop = useCallback(() => cancelRef.current?.(), []);

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
    onCancel: async () => {
      cancelRef.current?.();
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

  /** Esc walks back one screen, then closes — scoped so dialogs keep theirs. */
  const onPanelKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (view !== "thread") setView("thread");
    else setOpen(false);
  };

  const driverSwitch = (
    <div className="seg" role="group" aria-label="Agent driver">
      {(["scripted", "llm"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          disabled={running}
          onClick={() => setMode(value)}
        >
          {value === "scripted" ? "Scripted" : "Live"}
        </button>
      ))}
    </div>
  );

  const welcome =
    mode === "scripted" ? (
      <div className="welcome">
        <span className="welcome-title">The reference scenario</span>
        <p className="welcome-body">
          A fake model narrows the filters, reads the table, selects the offline Milano devices
          and asks you to approve disabling them. Deterministic, no LLM — this is the path CI
          runs. Turn on <b>step by step</b> to park it before every call.
        </p>
      </div>
    ) : (
      <div className="welcome">
        <span className="welcome-title">Ask the agent to change this page</span>
        <p className="welcome-body">
          It gets the same catalog the scripted run does, re-listed every turn — plus your
          confirmations, bound inputs and typed errors.
        </p>
        <div className="suggests">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className="suggest"
              disabled={!apiKey || running}
              onClick={() => void runLive(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );

  const composer = (
    <div className="composer-wrap">
      {pendingStep ? (
        <StepGate pendingStep={pendingStep} onAction={(action) => releaseStepRef.current?.(action)} />
      ) : mode === "scripted" ? (
        <div className="composer">
          <p className="composer-fixed">“{SCENARIO_PROMPT}”</p>
          <div className="composer-floor">
            {driverSwitch}
            <label className="toggle">
              <input
                type="checkbox"
                aria-label="Step by step"
                checked={stepMode}
                disabled={running}
                onChange={(e) => setStepMode(e.target.checked)}
              />
              step by step
            </label>
            {running && cancelRef.current ? (
              <button
                type="button"
                className="send is-stop"
                onClick={stop}
                aria-label="Stop the run"
              >
                <Stop size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="send"
                data-testid="run-agent"
                disabled={running}
                onClick={() => void runScripted()}
                aria-label={stepMode ? "Run the scenario step by step" : "Run the scenario"}
                title={stepMode ? "Run step by step" : "Run scenario"}
              >
                <Play size={13} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <AgentComposer
          disabled={!apiKey || running}
          running={running}
          placeholder={
            apiKey ? "Ask the agent to do something…" : "Add an API key to send a task…"
          }
          onStop={stop}
          controls={
            <>
              {driverSwitch}
              <button
                type="button"
                className="chip"
                data-warn={!apiKey}
                onClick={() => setView("settings")}
                title="Connection settings"
              >
                <Sliders size={12} />
                <span>{apiKey ? model : "Add API key"}</span>
              </button>
            </>
          }
        />
      )}
      <span className="console-note">
        {mode === "scripted"
          ? "deterministic, no LLM — the path CI runs"
          : "a plain tool-calling loop over the same catalog"}
      </span>
    </div>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside
        className="console"
        role="complementary"
        aria-label="Agent console"
        ref={panelRef}
        onKeyDown={onPanelKeyDown}
      >
        <div className="console-head">
          <span className={`dot${pendingStep ? " parked" : running ? " running" : ""}`} />
          <span className="console-title">Agent console</span>
          <span className="sr-only" role="status">
            {pendingStep
              ? `Paused before step ${pendingStep.index}`
              : running
                ? "Agent running"
                : "Agent idle"}
          </span>

          <button
            className="surface-pill"
            aria-pressed={view === "surface"}
            onClick={() => setView((v) => (v === "surface" ? "thread" : "surface"))}
            title="What the agent can see right now"
          >
            <Layers size={12} />
            <b data-testid="tool-count">{toolset.tools().length}</b> tools · v{surfaceVersion}
          </button>

          <button
            className="iconbtn"
            data-testid="console-collapse"
            onClick={() => setOpen(false)}
            aria-label="Collapse the agent console"
            title="Collapse (⌘I)"
          >
            <ChevronDown size={15} />
          </button>
        </div>

        {view === "surface" ? (
          <SurfaceInspector
            registry={props.app.registry}
            consumer={CONSUMER}
            onBack={() => setView("thread")}
          />
        ) : view === "settings" ? (
          <ConnectionSettings
            apiKey={apiKey}
            model={model}
            remember={rememberKey}
            onApiKey={setApiKey}
            onModel={setModel}
            onRemember={(value) => persistKey(apiKey, value)}
            onBack={() => setView("thread")}
          />
        ) : (
          <AgentThread
            welcome={welcome}
            composer={composer}
            working={
              running && !pendingStep
                ? mode === "scripted"
                  ? "running the scenario"
                  : "thinking"
                : null
            }
          />
        )}
      </aside>
    </AssistantRuntimeProvider>
  );
}
