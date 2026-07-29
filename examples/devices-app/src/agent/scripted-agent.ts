/**
 * The scripted fake "model" (docs/14 M8 acceptance): lists tools, calls them,
 * and follows the machine-actionable `retry` hints from docs/07 — no LLM.
 * It completes the docs/10 scenario: "show me the offline devices in Milan,
 * select the visible ones and disable them".
 */
import { encodeWireName } from "@agent-surface/core";
import type { AgentInvocationResult, AgentTool, AgentToolset, JsonValue } from "@agent-surface/core";

export interface AgentTranscriptEntry {
  step: string;
  tool: string;
  input: JsonValue;
  result: AgentInvocationResult;
}

export class ScriptedAgentError extends Error {}

/**
 * Awaited before every tool call. The UI returns a promise in step mode, so
 * the user advances the agent one call at a time and watches the surface
 * change between steps.
 */
export type StepGate = (step: string, tool: string) => void | Promise<void>;

/**
 * Resolves a CAPABILITY id against the live catalog instead of hardcoding a
 * wire name: when several instances of a component are mounted, the adapter
 * disambiguates names per instance (`…_at_main`), so a fixed string would
 * miss. This is what any real agent does — plan from the surface it was
 * given, never from names memorised earlier.
 */
function findTool(toolset: AgentToolset, capabilityId: string, instance?: string): AgentTool {
  const base = encodeWireName(capabilityId);
  const tools = toolset.tools();
  const scoped = instance ? tools.find((t) => t.name === `${base}_at_${instance}`) : undefined;
  if (scoped) return scoped;
  const candidates = tools.filter((t) => t.name === base || t.name.startsWith(`${base}_at_`));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new ScriptedAgentError(`${capabilityId} is not in the current surface`);
  }
  throw new ScriptedAgentError(
    `${capabilityId} is exposed by ${candidates.length} instances — the agent must pick one`,
  );
}

let callCounter = 0;

/**
 * Executes one tool call, mechanically following retry hints:
 * - after-refresh → re-list the catalog, re-resolve the tool, retry once;
 * - after-delay   → wait details.retryAfterMs, retry once;
 * - with-confirmation is handled by the toolset's wait mode (one call → one
 *   final result once the user resolves the dialog);
 * - no / with-changes → surface the error to the caller (the "model" must
 *   change its plan, which a script cannot).
 */
async function call(
  toolset: AgentToolset,
  step: string,
  capabilityId: string,
  input: JsonValue,
  ctx: RunContext,
  depth = 0,
): Promise<AgentInvocationResult> {
  const tool = findTool(toolset, capabilityId);
  if (depth === 0) await ctx.gate?.(step, tool.name);
  callCounter += 1;
  const result = await tool.execute(input, { toolCallId: `call_${callCounter}` });
  ctx.transcript.push({ step, tool: tool.name, input, result });
  ctx.onStep?.({ step, tool: tool.name, input, result });
  // Let the host UI commit before the next step — a real adapter re-lists
  // tools between turns, which yields the same beat.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (result.status === "error" && depth < 1) {
    if (result.error.retry === "after-refresh") {
      return call(toolset, `${step} (retry after refresh)`, capabilityId, input, ctx, depth + 1);
    }
    if (result.error.retry === "after-delay") {
      const delay = Number(result.error.details?.retryAfterMs ?? 100);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return call(toolset, `${step} (retry after delay)`, capabilityId, input, ctx, depth + 1);
    }
  }
  return result;
}

interface RunContext {
  transcript: AgentTranscriptEntry[];
  gate?: StepGate;
  onStep?: (entry: AgentTranscriptEntry) => void;
}

export interface ScenarioOutcome {
  transcript: AgentTranscriptEntry[];
  disabled: number;
  selectedIds: string[];
}

export interface RunScenarioOptions {
  city: string;
  /** Awaited before each tool call — the step-by-step gate. */
  gate?: StepGate;
  /** Streams each settled call so the UI can render it immediately. */
  onStep?: (entry: AgentTranscriptEntry) => void;
}

/**
 * Reads an observation until two consecutive reads agree — the agent's way
 * of waiting for a view to settle after an action whose data consequences
 * are asynchronous (the app's own refetch, docs/01 litmus consequence).
 * Only the first read passes the step gate; the settle-polls are silent.
 */
async function readStable(
  toolset: AgentToolset,
  step: string,
  capabilityId: string,
  ctx: RunContext,
  maxTries = 20,
): Promise<AgentInvocationResult> {
  let previous: string | undefined;
  let last: AgentInvocationResult | undefined;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const silent: RunContext = attempt === 0 ? ctx : { ...ctx, gate: undefined, onStep: undefined };
    const before = ctx.transcript.length;
    const result = await call(toolset, step, capabilityId, {}, silent);
    if (attempt > 0) ctx.transcript.splice(before); // drop settle-poll noise
    if (result.status !== "ok") return result;
    const fingerprint = JSON.stringify(result.output);
    if (previous !== undefined && fingerprint === previous) return result;
    previous = fingerprint;
    last = result;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return last!;
}

/**
 * "Show me the offline devices in {city}, select the visible ones and disable
 * them. Then remove the filter."
 */
export async function runDevicesScenario(
  toolset: AgentToolset,
  options: RunScenarioOptions,
): Promise<ScenarioOutcome> {
  const ctx: RunContext = {
    transcript: [],
    ...(options.gate ? { gate: options.gate } : {}),
    ...(options.onStep ? { onStep: options.onStep } : {}),
  };
  const { transcript } = ctx;

  // 0 — the scenario is about the devices page: check where we are and
  // navigate there if needed. Navigation is a capability like any other, so
  // the agent can put itself in the right context instead of failing.
  const route = await call(toolset, "check the current page", "view:app.navigation.current", {}, ctx);
  if (route.status === "ok" && (route.output as { page: string }).page !== "devices") {
    const moved = await call(toolset, "go to the devices page", "view:app.navigation.goTo", {
      page: "devices",
    }, ctx);
    if (moved.status !== "ok") throw new ScriptedAgentError("could not reach the devices page");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // 1 — narrow the view (a presentation action; the refetch is the app's).
  const filtered = await call(toolset, "narrow the view", "view:devices.filters.set", {
    status: "offline",
    city: options.city,
  }, ctx);
  if (filtered.status !== "ok") throw new ScriptedAgentError("filters.set failed");

  // 2 — read the semantic state (targeted observation, not a DOM dump),
  // waiting for the app's data layer to settle under the new filters.
  const state = await readStable(toolset, "read what is visible", "view:devices.table.readState", ctx);
  if (state.status !== "ok") throw new ScriptedAgentError("readState failed");
  const rows = (state.output as { visibleRows: Array<{ id: string }> }).visibleRows;
  const ids = rows.map((r) => r.id);

  let disabled = 0;
  if (ids.length > 0) {
    // 3 — select the visible rows.
    const selected = await call(toolset, "select the visible rows", "view:devices.table.selectRows", {
      ids,
      mode: "replace",
    }, ctx);
    if (selected.status !== "ok") throw new ScriptedAgentError("selectRows failed");

    // 4 — execute the authoritative mutation. Inputs are BOUND to the
    // selection (the agent sends {}); the destructive effect demands user
    // confirmation, which the toolset's wait mode resolves against the dialog.
    const disableResult = await call(toolset, "disable the selection", "domain:devices.disable", {}, ctx);
    if (disableResult.status === "ok") {
      disabled = (disableResult.output as { disabled: number }).disabled;
      // 5 — verify through the surface, as the docs suggest after mutations.
      await readStable(toolset, "verify the result", "view:devices.table.readState", ctx, 5);
    }
  }

  // 6 — put the view back the way it was found.
  await call(toolset, "remove the filter", "view:devices.filters.set", {
    status: "all",
    city: null,
  }, ctx);

  return { transcript, disabled, selectedIds: ids };
}
