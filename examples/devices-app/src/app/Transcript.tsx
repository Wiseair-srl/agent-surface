import type { AgentCapabilityErrorPayload, JsonValue } from "@agent-surface/core";

/**
 * The agent's work as a compact timeline: one line per tool call, collapsed
 * by default. Expanding a line reveals the exact arguments and the raw
 * payload — the reviewable evidence, one click away rather than always on.
 */

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "note"; text: string }
  | {
      kind: "call";
      tool: string;
      args: JsonValue;
      status: "pending" | "ok" | "error";
      output?: JsonValue;
      error?: AgentCapabilityErrorPayload;
    };

/** `view_devices__table__selectRows_at_main` → plane, capability id, instance. */
function describeTool(tool: string): {
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

/** The one-line "what came back". */
function resultLine(entry: Extract<TranscriptEntry, { kind: "call" }>): string {
  if (entry.status === "pending") return "running…";
  if (entry.status === "error") return entry.error?.code ?? "error";
  const output = entry.output;
  if (output === undefined || output === null) return "ok";
  if (typeof output !== "object" || Array.isArray(output)) return compact(output);
  const record = output as Record<string, JsonValue>;
  if (Array.isArray(record.visibleRows)) {
    const rows = record.visibleRows.length;
    const selected = Array.isArray(record.selectedIds) ? record.selectedIds.length : 0;
    return `${rows} row${rows === 1 ? "" : "s"} · ${selected} selected`;
  }
  if (typeof record.disabled === "number") return `${record.disabled} disabled`;
  const keys = Object.keys(record);
  return keys.length === 0 ? "ok" : keys.map((k) => `${k}=${compact(record[k] as JsonValue)}`).join("  ");
}

const RETRY_HINT: Record<string, string> = {
  "after-refresh": "re-read state, then retry",
  "after-delay": "wait, then retry",
  "with-changes": "fix the input",
  "with-confirmation": "needs user approval",
  yes: "safe to retry",
  no: "do not retry",
};

function CallRow(props: { entry: Extract<TranscriptEntry, { kind: "call" }> }) {
  const { entry } = props;
  const { plane, id, instance } = describeTool(entry.tool);
  const hasDetail = entry.output !== undefined || entry.error !== undefined;

  return (
    <details className={`step step-${entry.status}`}>
      <summary className="step-row">
        <span className={`step-plane ${plane}`}>{plane}</span>
        <span className="step-id">
          {id}
          {instance && <span className="step-instance">@{instance}</span>}
        </span>
        <span className="step-result">{resultLine(entry)}</span>
        <span className={`step-mark ${entry.status}`} aria-hidden="true">
          {entry.status === "ok" ? "✓" : entry.status === "error" ? "!" : "·"}
        </span>
      </summary>

      <div className="step-detail">
        <div className="step-kv">
          <span className="step-k">input</span>
          <code className="step-v">{argLine(entry.args)}</code>
        </div>
        {entry.status === "error" && entry.error && (
          <>
            <div className="step-kv">
              <span className="step-k">retry</span>
              <code className="step-v">{RETRY_HINT[entry.error.retry] ?? entry.error.retry}</code>
            </div>
            <p className="step-msg">{entry.error.message}</p>
          </>
        )}
        {hasDetail && (
          <pre className="step-raw">
            {JSON.stringify(entry.error ?? entry.output ?? null, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

export function Transcript(props: { entries: TranscriptEntry[] }) {
  if (props.entries.length === 0) {
    return (
      <div className="transcript" data-testid="agent-transcript">
        <p className="transcript-empty">
          Every tool call the agent makes against this page shows up here.
        </p>
      </div>
    );
  }
  return (
    <div className="transcript" data-testid="agent-transcript">
      {props.entries.map((entry, i) => {
        if (entry.kind === "user") {
          return (
            <p className="msg msg-user" key={i}>
              {entry.text}
            </p>
          );
        }
        if (entry.kind === "assistant") {
          return (
            <p className="msg msg-assistant" key={i}>
              {entry.text}
            </p>
          );
        }
        if (entry.kind === "note") {
          return (
            <p className="msg msg-note" key={i}>
              {entry.text}
            </p>
          );
        }
        return <CallRow entry={entry} key={i} />;
      })}
    </div>
  );
}
