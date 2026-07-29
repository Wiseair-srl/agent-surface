/**
 * A REAL model driving the live surface — the optional counterpart to the
 * scripted agent (docs/14 M10: "optional real provider behind an env var —
 * never in CI"). The loop is host code by design: agent-surface produces the
 * tool catalog and executes tool calls; it never talks to a provider itself
 * (docs/02).
 *
 * The API key is supplied by the user at runtime (or via
 * VITE_OPENROUTER_API_KEY) and is sent ONLY to openrouter.ai.
 */
import type { AgentCapabilityErrorPayload, AgentToolset, JsonValue } from "@agent-surface/core";

export type LlmAgentEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool-call"; tool: string; args: JsonValue }
  | {
      kind: "tool-result";
      tool: string;
      ok: boolean;
      output?: JsonValue;
      error?: AgentCapabilityErrorPayload;
    }
  | { kind: "error"; message: string }
  | { kind: "done"; turns: number };

export interface RunLlmAgentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  onEvent: (event: LlmAgentEvent) => void;
  signal?: AbortSignal;
  maxTurns?: number;
}

const SYSTEM_PROMPT = [
  "You operate a devices dashboard through typed tools exposed by agent-surface.",
  "Tools prefixed [view · …] read or change what the user currently sees; tools prefixed [domain · …] execute authoritative server operations.",
  "Work stepwise: read state with observations before acting; act with the smallest capability that expresses the user's intent.",
  "Some domain inputs are bound to the UI state (for example the current selection) — call those tools with {} and never invent values for bound fields.",
  "Errors are protocol: follow their `retry` hint (`after-refresh` → re-read state and retry once; `after-delay` → wait; `no` → stop and explain). A required user confirmation is handled for you — the call simply resolves once the user decides.",
  "When the task is complete, reply with a short summary of what changed.",
].join(" ");

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export async function runLlmAgent(
  toolset: AgentToolset,
  options: RunLlmAgentOptions,
): Promise<void> {
  const { onEvent } = options;
  const maxTurns = options.maxTurns ?? 16;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: options.prompt },
  ];
  onEvent({ kind: "user", text: options.prompt });

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Re-list per turn: the catalog follows the surface version (docs/09).
    const tools = toolset.tools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": globalThis.location?.origin ?? "http://localhost",
          "X-Title": "agent-surface devices example",
        },
        body: JSON.stringify({ model: options.model, messages, tools, tool_choice: "auto" }),
      });
    } catch (err) {
      onEvent({
        kind: "error",
        message: `network error talking to OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      onEvent({
        kind: "error",
        message: `OpenRouter ${response.status}: ${body.slice(0, 300) || response.statusText}`,
      });
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: ChatMessage }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) {
      onEvent({ kind: "error", message: "OpenRouter returned no choices" });
      return;
    }
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });

    if (typeof message.content === "string" && message.content.trim().length > 0) {
      onEvent({ kind: "assistant", text: message.content.trim() });
    }

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      onEvent({ kind: "done", turns: turn });
      return;
    }

    for (const call of toolCalls) {
      let args: JsonValue = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as JsonValue) : {};
      } catch {
        /* leave {} — the registry validates and answers with INVALID_INPUT */
      }
      onEvent({ kind: "tool-call", tool: call.function.name, args });
      const tool = toolset.tools().find((t) => t.name === call.function.name);
      if (!tool) {
        const error: AgentCapabilityErrorPayload = {
          code: "CAPABILITY_NOT_FOUND",
          message: "Tool not in the current catalog; the surface changed. Plan from fresh state.",
          retry: "after-refresh",
        };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error }),
        });
        onEvent({ kind: "tool-result", tool: call.function.name, ok: false, error });
        continue;
      }
      const result = await tool.execute(args, { toolCallId: call.id });
      const ok = result.status === "ok";
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(
          ok ? { ok: true, output: result.output ?? null } : { ok: false, error: result.error },
        ),
      });
      onEvent({
        kind: "tool-result",
        tool: call.function.name,
        ok,
        ...(result.status === "ok"
          ? result.output !== undefined
            ? { output: result.output }
            : {}
          : { error: result.error }),
      });
    }
  }
  onEvent({ kind: "error", message: `stopped after ${maxTurns} turns without a final answer` });
}
