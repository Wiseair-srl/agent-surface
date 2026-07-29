/**
 * Canonical ID grammar (docs/01 §identity):
 *
 *   capability-id   = plane ":" component-type "." capability-name
 *   plane           = "view" | "domain"
 *   component-type  = segment *( "." segment )
 *   segment         = lowercase-letter *( lowercase-letter / digit / "-" )
 *   capability-name = lowercase-letter *( letter / digit )   ; camelCase, no dots
 *   instance-id     = 1*( letter / digit / "-" / "_" )
 *
 * Underscores are reserved for the wire-name encoding (docs/09).
 */

export const MAX_ID_LENGTH = 128;

const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]+$/;

export type AgentPlane = "view" | "domain";

export function isValidComponentType(type: string): boolean {
  if (type.length === 0 || type.length > MAX_ID_LENGTH) return false;
  return type.split(".").every((seg) => SEGMENT_RE.test(seg));
}

export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_NAME_RE.test(name);
}

export function isValidInstanceId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_LENGTH && INSTANCE_ID_RE.test(id);
}

export function formatViewCapabilityId(componentType: string, name: string): string {
  return `view:${componentType}.${name}`;
}

export function formatDomainCapabilityId(path: string): string {
  return `domain:${path}`;
}

export interface ParsedViewCapabilityId {
  plane: "view";
  componentType: string;
  name: string;
}
export interface ParsedDomainCapabilityId {
  plane: "domain";
  /** Canonical oRPC procedure path — treated as opaque (docs/01). */
  path: string;
}
export type ParsedCapabilityId = ParsedViewCapabilityId | ParsedDomainCapabilityId;

/** Parses a capability id; returns undefined when the grammar is violated. */
export function parseCapabilityId(id: string): ParsedCapabilityId | undefined {
  if (id.length > MAX_ID_LENGTH) return undefined;
  if (id.startsWith("view:")) {
    const rest = id.slice("view:".length);
    // The capability name is everything after the LAST dot (docs/01).
    const lastDot = rest.lastIndexOf(".");
    if (lastDot <= 0) return undefined;
    const componentType = rest.slice(0, lastDot);
    const name = rest.slice(lastDot + 1);
    if (!isValidComponentType(componentType) || !isValidCapabilityName(name)) {
      return undefined;
    }
    return { plane: "view", componentType, name };
  }
  if (id.startsWith("domain:")) {
    const path = id.slice("domain:".length);
    if (path.length === 0) return undefined;
    return { plane: "domain", path };
  }
  return undefined;
}

/* ───────────────────────────── wire names ─────────────────────────────
 * encode(id): ":" → "_"    "." → "__"
 * decode(name): first "_" splits the plane (the grammar forbids "_" in ids);
 * "__" → "."
 * Names longer than 64 chars: truncate to 56 + "_" + 7-char hash of the id.
 */

export const MAX_WIRE_NAME_LENGTH = 64;

function fnv1aHash36(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

export function encodeWireName(id: string): string {
  return encodeWireNameForInstance(id);
}

/**
 * Wire name disambiguated per instance: providers require UNIQUE tool names,
 * so when several live instances expose the same capability the adapter
 * appends `_at_<instanceId>` (docs/09 rule 7 — the id↔name map stays
 * authoritative; instance ids never contain "." so decoding stays possible
 * by stripping the suffix).
 */
export function encodeWireNameForInstance(id: string, instanceId?: string): string {
  const raw =
    id.replace(":", "_").replaceAll(".", "__") + (instanceId ? `_at_${instanceId}` : "");
  if (raw.length <= MAX_WIRE_NAME_LENGTH) return raw;
  return `${raw.slice(0, 56)}_${fnv1aHash36(`${id}#${instanceId ?? ""}`)}`;
}

/**
 * Reverses `encodeWireName` for non-truncated names. Truncated names cannot
 * be decoded — the adapter's id↔name map is authoritative (docs/09 rule 7).
 */
export function decodeWireName(name: string): string | undefined {
  const planeEnd = name.indexOf("_");
  if (planeEnd <= 0) return undefined;
  const plane = name.slice(0, planeEnd);
  if (plane !== "view" && plane !== "domain") return undefined;
  const rest = name.slice(planeEnd + 1).replaceAll("__", ".");
  return `${plane}:${rest}`;
}
