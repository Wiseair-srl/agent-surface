import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { AgentCapabilityErrorPayload, JsonValue } from "@agent-surface/core";

/**
 * One agent tool call, rendered as a row in the chat thread — collapsed by
 * default, with the exact arguments and raw payload one click away.
 *
 * assistant-ui models a tool call as a first-class part of an assistant
 * message, so this is registered as the thread's tool UI rather than being a
 * bespoke list item: the same component renders a call whether it came from
 * the scripted agent or from a live model.
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

/** The one-line "what did it ask for" shown on the collapsed row. */
function argLine(args: JsonValue): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return compact(args);
  const entries = Object.entries(args);
  if (entries.length === 0) return "inputs bound from UI state";
  return entries.map(([k, v]) => `${k}=${compact(v as JsonValue)}`).join("  ");
}

type CallStatus = "pending" | "ok" | "error";

/** The one-line "what came back". */
function resultLine(status: CallStatus, result: JsonValue | undefined): string {
  if (status === "pending") return "running…";
  if (status === "error") {
    return (result as AgentCapabilityErrorPayload | undefined)?.code ?? "error";
  }
  if (result === undefined || result === null) return "ok";
  if (typeof result !== "object" || Array.isArray(result)) return compact(result);
  const record = result as Record<string, JsonValue>;
  if (Array.isArray(record.visibleRows)) {
    const rows = record.visibleRows.length;
    const selected = Array.isArray(record.selectedIds) ? record.selectedIds.length : 0;
    return `${rows} row${rows === 1 ? "" : "s"} · ${selected} selected`;
  }
  if (typeof record.disabled === "number") return `${record.disabled} disabled`;
  const keys = Object.keys(record);
  return keys.length === 0
    ? "ok"
    : keys.map((k) => `${k}=${compact(record[k] as JsonValue)}`).join("  ");
}

const RETRY_HINT: Record<string, string> = {
  "after-refresh": "re-read state, then retry",
  "after-delay": "wait, then retry",
  "with-changes": "fix the input",
  "with-confirmation": "needs user approval",
  yes: "safe to retry",
  no: "do not retry",
};

/**
 * The thread's tool UI. assistant-ui hands us the call's name, arguments,
 * status and result; the agent-surface reading of it — which plane it touched,
 * and what the typed error says to do next — is ours to render.
 */
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

  return (
    <details className={`step step-${callStatus}`}>
      <summary className="step-row">
        <span className={`step-plane ${plane}`}>{plane}</span>
        <span className="step-id">
          {id}
          {instance && <span className="step-instance">@{instance}</span>}
        </span>
        <span className="step-result">{resultLine(callStatus, payload)}</span>
        <span className={`step-mark ${callStatus}`} aria-hidden="true">
          {callStatus === "ok" ? "✓" : callStatus === "error" ? "!" : "·"}
        </span>
      </summary>

      <div className="step-detail">
        <div className="step-kv">
          <span className="step-k">input</span>
          <code className="step-v">{argLine((args ?? {}) as JsonValue)}</code>
        </div>
        {error && (
          <>
            <div className="step-kv">
              <span className="step-k">retry</span>
              <code className="step-v">{RETRY_HINT[error.retry] ?? error.retry}</code>
            </div>
            <p className="step-msg">{error.message}</p>
          </>
        )}
        {payload !== undefined && (
          <pre className="step-raw">{JSON.stringify(payload, null, 2)}</pre>
        )}
      </div>
    </details>
  );
};
