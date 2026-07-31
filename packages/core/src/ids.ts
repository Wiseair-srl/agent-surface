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
  // The signature says `string`, and this is the boundary where that assumption
  // is load-bearing: a caller relaying a malformed request (an adapter whose
  // envelope carried no `capabilityId`) must get a grammar rejection —
  // CAPABILITY_NOT_FOUND — not a TypeError the pipeline reports as an internal
  // defect with retry:"no".
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH) return undefined;
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
 * Names that would exceed 64 chars are SHORTENED: kept prefix + "_0_" + hash
 * of the full id. The marker makes shortening self-evident, so `decodeWireName`
 * can refuse rather than return a plausible wrong id (D30).
 */

export const MAX_WIRE_NAME_LENGTH = 64;

/**
 * Marks a shortened name. Unreachable in a faithful encoding of a `view:` id
 * (the grammar forbids "_", and no segment or capability name may start with a
 * digit). A `domain:` path with a bare "0" segment would produce it — decoding
 * such a name is refused rather than guessed, which is the safe direction.
 */
const SHORTENED_MARKER = "_0_";
/** Instance disambiguator (docs/09 rule 7); also not decodable by inspection. */
const INSTANCE_MARKER = "_at_";

/** FNV-1a, base36, extended by re-seeding when more characters are asked for. */
function hash36(input: string, length: number): string {
  let out = "";
  for (let round = 0; out.length < length; round++) {
    let hash = (0x811c9dc5 ^ round) >>> 0;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(36).padStart(7, "0");
  }
  return out.slice(0, length);
}

function rawWireName(id: string, instanceId?: string): string {
  const encoded = id.replace(":", "_").replaceAll(".", "__");
  return instanceId ? `${encoded}${INSTANCE_MARKER}${instanceId}` : encoded;
}

export function encodeWireName(id: string): string {
  return encodeWireNameForInstance(id);
}

/**
 * Wire name disambiguated per instance: providers require UNIQUE tool names,
 * so when several live instances expose the same capability the adapter
 * appends `_at_<instanceId>` (docs/09 rule 7 — the id↔name map stays
 * authoritative).
 *
 * The result is ALWAYS ≤ 64 characters (`AS-WIRE-004`) and deterministic for a
 * given `(id, instanceId, level)` (`AS-WIRE-005`). `level` escalates the hash
 * when a catalog would otherwise emit the same name twice — see
 * {@link assignWireNames}, which owns that check; callers with a whole catalog
 * in hand should use it rather than this function directly.
 */
export function encodeWireNameForInstance(
  id: string,
  instanceId?: string,
  level = 0,
): string {
  const raw = rawWireName(id, instanceId);
  if (level === 0 && raw.length <= MAX_WIRE_NAME_LENGTH) return raw;
  const hashLength = 7 + level * 2;
  const keep = MAX_WIRE_NAME_LENGTH - SHORTENED_MARKER.length - hashLength;
  const hash = hash36(`${id}#${instanceId ?? ""}#${level}`, hashLength);
  return `${raw.slice(0, keep)}${SHORTENED_MARKER}${hash}`;
}

export interface WireNameEntry {
  /** Canonical capability id. */
  id: string;
  /** Instance disambiguator, when several live instances share the id. */
  instanceId?: string;
}

export interface WireNameAssignment {
  /** Emitted names, positionally aligned with the input entries. */
  names: string[];
  /** wireName → canonical id. Authoritative; shortened names are not decodable. */
  byName: ReadonlyMap<string, string>;
}

/**
 * Assigns wire names to a whole catalog, guaranteeing uniqueness within it
 * (`AS-WIRE-006`). Two distinct entries that collide are BOTH re-encoded at the
 * next hash level, so the outcome depends on the set of entries and not on
 * their order (`AS-WIRE-005`). Escalation is bounded; the last level appends
 * the entry's rank among the colliding keys, which terminates by construction.
 */
export function assignWireNames(entries: readonly WireNameEntry[]): WireNameAssignment {
  const keyOf = (e: WireNameEntry): string => `${e.id}#${e.instanceId ?? ""}`;
  const level = new Map<string, number>();
  const MAX_LEVEL = 3;

  let names = entries.map((e) => encodeWireNameForInstance(e.id, e.instanceId));
  for (let round = 0; round <= MAX_LEVEL; round++) {
    const byName = new Map<string, Set<string>>();
    entries.forEach((entry, i) => {
      const set = byName.get(names[i]!) ?? new Set<string>();
      set.add(keyOf(entry));
      byName.set(names[i]!, set);
    });
    const colliding = new Set<string>();
    for (const [, keys] of byName) {
      if (keys.size > 1) for (const key of keys) colliding.add(key);
    }
    if (colliding.size === 0) break;
    if (round === MAX_LEVEL) {
      // Terminal tie-break: rank within the sorted colliding keys is unique by
      // definition and stable for a given set.
      const ranked = [...colliding].sort();
      names = entries.map((entry, i) => {
        const rank = ranked.indexOf(keyOf(entry));
        if (rank < 0) return names[i]!;
        const suffix = `${SHORTENED_MARKER}${rank}`;
        const base = encodeWireNameForInstance(entry.id, entry.instanceId, MAX_LEVEL);
        return `${base.slice(0, MAX_WIRE_NAME_LENGTH - suffix.length)}${suffix}`;
      });
      break;
    }
    for (const key of colliding) level.set(key, (level.get(key) ?? 0) + 1);
    names = entries.map((entry) =>
      encodeWireNameForInstance(entry.id, entry.instanceId, level.get(keyOf(entry)) ?? 0),
    );
  }

  const byName = new Map<string, string>();
  entries.forEach((entry, i) => byName.set(names[i]!, entry.id));
  return { names, byName };
}

/**
 * Reverses `encodeWireName` for names that were encoded faithfully, and returns
 * `undefined` for every name that was not — shortened names and per-instance
 * names among them (`AS-WIRE-007`: consult `toolset.wireNameMap()` instead).
 * Returning a plausible-but-wrong canonical id would take the audit identity
 * with it, so this refuses anything it cannot re-encode byte-identically.
 */
export function decodeWireName(name: string): string | undefined {
  if (name.includes(SHORTENED_MARKER) || name.includes(INSTANCE_MARKER)) return undefined;
  const planeEnd = name.indexOf("_");
  if (planeEnd <= 0) return undefined;
  const plane = name.slice(0, planeEnd);
  if (plane !== "view" && plane !== "domain") return undefined;
  const id = `${plane}:${name.slice(planeEnd + 1).replaceAll("__", ".")}`;
  // The codec is injective only for grammar-valid ids with no "_" of their own.
  if (id.includes("_") || !parseCapabilityId(id) || encodeWireName(id) !== name) return undefined;
  return id;
}
