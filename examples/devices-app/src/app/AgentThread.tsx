import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { AgentCapabilityErrorPayload, JsonValue } from "@agent-surface/core";
import { ArrowUp, Stop } from "./Icons.js";
import { ToolCallRow } from "./ToolCall.js";

/**
 * The chat thread, built on assistant-ui's headless primitives.
 *
 * The console owns the messages and the run loop (a scripted agent, or a live
 * model over the same toolset), so the runtime is an external store — see
 * AgentConsole. What assistant-ui contributes is the thread itself: message
 * grouping, viewport auto-scroll and stick-to-bottom, composer state and
 * submit semantics, and tool calls as a first-class part of an assistant
 * message rather than log lines we format by hand.
 */

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "note"; text: string; tone?: "plain" | "error" }
  | {
      kind: "call";
      tool: string;
      args: JsonValue;
      status: "pending" | "ok" | "error";
      output?: JsonValue;
      error?: AgentCapabilityErrorPayload;
    };

/** Entries carry an id so the thread can keep identity across re-renders. */
export type StoredEntry = TranscriptEntry & { id: string };

/**
 * Our entries → assistant-ui messages. A tool call becomes a `tool-call`
 * content part, which is what routes it to ToolCallRow below; run lifecycle
 * notes become system messages, which the thread renders as centred meta
 * lines rather than as somebody's turn.
 */
export function convertEntry(entry: StoredEntry): ThreadMessageLike {
  switch (entry.kind) {
    case "user":
      return { id: entry.id, role: "user", content: [{ type: "text", text: entry.text }] };
    case "assistant":
      return { id: entry.id, role: "assistant", content: [{ type: "text", text: entry.text }] };
    case "note":
      return {
        id: entry.id,
        role: "system",
        content: [{ type: "text", text: entry.text }],
        metadata: { custom: { tone: entry.tone ?? "plain" } },
      };
    case "call":
      return {
        id: entry.id,
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: entry.id,
            toolName: entry.tool,
            args: (entry.args ?? {}) as Record<string, JsonValue>,
            argsText: JSON.stringify(entry.args ?? {}),
            ...(entry.status === "pending"
              ? {}
              : { result: entry.status === "error" ? entry.error : (entry.output ?? null) }),
            ...(entry.status === "error" ? { isError: true } : {}),
          },
        ],
      };
  }
}

const TOOL_COMPONENTS = { tools: { Fallback: ToolCallRow } };

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <MessagePrimitive.Parts components={TOOL_COMPONENTS} />
    </MessagePrimitive.Root>
  );
}

/** Run lifecycle ("Finished — disabled 3 devices"), not a turn. */
function NoteMessage(props: { tone: string }) {
  return (
    <MessagePrimitive.Root
      className={`msg msg-note${props.tone === "error" ? " is-error" : ""}`}
      role="status"
    >
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

export function AgentThread(props: {
  welcome: React.ReactNode;
  composer: React.ReactNode;
  /** Shown while a run is in flight and not parked on a gate. */
  working: string | null;
}) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="transcript" data-testid="agent-transcript">
        <AuiIf condition={(s) => s.thread.isEmpty}>{props.welcome}</AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) => {
            if (message.role === "user") return <UserMessage />;
            if (message.role === "system") {
              const tone = (message.metadata?.custom as { tone?: string } | undefined)?.tone;
              return <NoteMessage tone={tone ?? "plain"} />;
            }
            return <AssistantMessage />;
          }}
        </ThreadPrimitive.Messages>

        {props.working && (
          <p className="working" role="status">
            {props.working}
          </p>
        )}
      </ThreadPrimitive.Viewport>

      {props.composer}
    </ThreadPrimitive.Root>
  );
}

/**
 * The live-model composer. One soft shell holds the input and every control
 * that governs the next run — driver, connection, send — so there is exactly
 * one place to look before an agent is allowed to touch the page. Enter
 * submits, which starts a run through the external store's `onNew`.
 */
export function AgentComposer(props: {
  disabled: boolean;
  running: boolean;
  placeholder: string;
  controls: React.ReactNode;
  onStop: () => void;
}) {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input
        className="composer-input"
        aria-label="Task for the model"
        placeholder={props.placeholder}
        rows={1}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
      />
      <div className="composer-floor">
        {props.controls}
        {props.running ? (
          <button
            type="button"
            className="send is-stop"
            onClick={props.onStop}
            aria-label="Stop the run"
            title="Stop the run"
          >
            <Stop size={13} />
          </button>
        ) : (
          <ComposerPrimitive.Send
            className="send"
            data-testid="run-llm"
            disabled={props.disabled}
            aria-label="Send the task"
            title="Send"
          >
            <ArrowUp size={15} />
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}
