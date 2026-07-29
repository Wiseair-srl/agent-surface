import type { JsonValue } from "./types.js";

/** Deep equality over JsonValue (order-sensitive for arrays, docs/06 rule 2). */
export function jsonDeepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonDeepEqual(v, b[i] as JsonValue))
    );
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every(
        (k, i) =>
          k === kb[i] &&
          jsonDeepEqual(
            (a as Record<string, JsonValue>)[k],
            (b as Record<string, JsonValue>)[k],
          ),
      )
    );
  }
  return false;
}

/** Recursive freeze of plain data (descriptors are deep-frozen JSON). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Structured clone via JSON semantics (strips undefined, rejects non-JSON). */
export function jsonClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as object).every(
      (v) => v === undefined || isJsonValue(v, depth + 1),
    );
  }
  return false;
}

export function byteLength(value: unknown): number {
  const s = JSON.stringify(value);
  return s === undefined ? 0 : s.length;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomBase62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Truncate a string for agent-safe messages/summaries. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}
