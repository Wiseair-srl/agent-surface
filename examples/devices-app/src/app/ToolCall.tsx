import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { AgentCapabilityErrorPayload, JsonValue } from "@agent-surface/core";
import { Check, ChevronDown, Loader, XCircle } from "./Icons.js";

/**
 * One agent tool call, rendered as a row in the chat thread.
 *
 * assistant-ui models a tool call as a first-class part of an assistant
 * message, so this is registered as the thread's tool UI rather than being a
 * bespoke list item: the same component renders a call whether it came from
 * the scripted agent or from a live model. The disclosure grammar is the
 * library's own — status icon, name, rotating chevron, payloads in a muted
 * block — and the agent-surface reading of it is ours: which PLANE the call
 * touched, and what the typed error says to do next.
 *
 * The plane gets its own column, before the name. Scanning a settled run,
 * the first thing you should be able to answer is "did this agent only move
 * the view, or did it write something", and that answer is a column of
 * chips, not a word buried in a label.
 */

/** `view_devices__table__selectRows_at_main` → plane, capability id, instance. */
export function describeTool(tool: string): {
  plane: "view" | "domain" | "meta";
  id: string;
  instance?: string;
} {
  const [wire, instance] = tool.split("_at_");
  const raw = wire ?? tool;
  const plane = raw.startsWith("view_") ? "view" : raw.startsWith("domain_") ? "domain" : "meta";
  const id = raw.replace(/^(view|domain)_/, "").replaceAll("__", ".");
  return { plane, id, ...(instance ? { instance } : {}) };
}

function compact(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const head = value
      .slice(0, 2)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(", ");
    return value.length > 2 ? `[${head}, +${value.length - 2}]` : `[${head}]`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type CallStatus = "pending" | "ok" | "error";

/**
 * The one-line "what came back", in the app's own vocabulary rather than in
 * JSON: a table read says how many rows and how many are selected, a disable
 * says how many it disabled. The raw payload is one click away for the cases
 * where the summary is not enough.
 */
function resultLine(status: CallStatus, result: JsonValue | undefined): string {
  if (status === "pending") return "running";
  if (status === "error") {
    return (result as AgentCapabilityErrorPayload | undefined)?.code ?? "error";
  }
  if (result === undefined || result === null) return "ok";
  if (typeof result !== "object" || Array.isArray(result)) return compact(result);
  const record = result as Record<string, JsonValue>;
  if (Array.isArray(record.visibleRows)) {
    const rows = record.visibleRows.length;
    const selected = Array.isArray(record.selectedIds) ? record.selectedIds.length : 0;
    return selected > 0
      ? `${rows} row${rows === 1 ? "" : "s"} · ${selected} selected`
      : `${rows} row${rows === 1 ? "" : "s"}`;
  }
  if (typeof record.disabled === "number") return `${record.disabled} disabled`;
  const keys = Object.keys(record);
  return keys.length === 0
    ? "ok"
    : keys.map((k) => `${k}=${compact(record[k] as JsonValue)}`).join(" ");
}

/** docs/07: every typed error carries a machine-actionable next move. */
const RETRY_HINT: Record<string, string> = {
  "after-refresh": "re-read the state, then retry",
  "after-delay": "wait, then retry",
  "with-changes": "fix the input and retry",
  "with-confirmation": "ask the user to approve",
  yes: "safe to retry as-is",
  no: "do not retry",
};

function StatusIcon(props: { status: CallStatus }) {
  if (props.status === "ok") return <Check size={15} className="step-mark" />;
  if (props.status === "error") return <XCircle size={15} className="step-mark" />;
  return <Loader size={15} className="step-mark" />;
}

export const ToolCallRow: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
}) => {
  // Deliberately NOT assistant-ui's `status`: that tracks the thread's run,
  // so the trailing message reads "running" even once this call has settled.
  // A result is only attached when the invocation itself has come back.
  const callStatus: CallStatus = isError ? "error" : result === undefined ? "pending" : "ok";
  const { plane, id, instance } = describeTool(toolName);
  const payload = result as JsonValue | undefined;
  // On the error path the result IS the typed error payload we put there in
  // convertEntry; assistant-ui only knows it as opaque JSON.
  const error =
    callStatus === "error" ? (payload as unknown as AgentCapabilityErrorPayload) : undefined;
  const input = (args ?? {}) as JsonValue;
  const hasInput = input !== null && typeof input === "object" && Object.keys(input).length > 0;

  return (
    <details className={`step step-${callStatus}`}>
      <summary className="step-row">
        <StatusIcon status={callStatus} />
        <span className={`plane ${plane}`}>{plane}</span>
        <span className="step-id">
          {id}
          {instance && <span className="step-instance">@{instance}</span>}
        </span>
        <span className="step-result">{resultLine(callStatus, payload)}</span>
        <ChevronDown size={14} className="step-caret" />
      </summary>

      <div className="step-detail">
        <div>
          <span className="step-detail-label">input</span>
          <pre className="step-pre">
            {hasInput
              ? JSON.stringify(input, null, 2)
              : "{}\n\n// no arguments: every field is bound to the live UI state"}
          </pre>
        </div>

        {error && (
          <>
            <p className="step-msg">{error.message}</p>
            <span className="retry">
              retry <b>{error.retry}</b> — {RETRY_HINT[error.retry] ?? "see the payload"}
            </span>
          </>
        )}

        {payload !== undefined && payload !== null && (
          <div>
            <span className="step-detail-label">{error ? "error" : "output"}</span>
            <pre className="step-pre">{JSON.stringify(payload, null, 2)}</pre>
          </div>
        )}
      </div>
    </details>
  );
};
