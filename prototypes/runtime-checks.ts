/**
 * prototypes/runtime-checks.ts
 *
 * Executable mirrors of two normative algorithms from the spec, verified
 * with asserts. Run: `node --experimental-strip-types prototypes/runtime-checks.ts`
 * (companion to api-typecheck.ts, which is declare-only and tsc-only).
 */

type JsonValue =
  | string | number | boolean | null
  | JsonValue[] | { [key: string]: JsonValue };

/** Wire-name codec — docs/09 §wire-names (the id grammar never allows "_"). */
function encodeWireName(id: string): string {
  return id.replace(":", "_").replaceAll(".", "__");
}
function decodeWireName(name: string): string {
  const planeEnd = name.indexOf("_");
  const plane = name.slice(0, planeEnd);
  const rest = name.slice(planeEnd + 1).replaceAll("__", ".");
  return `${plane}:${rest}`;
}

/** Deep-equal used for confirmation input matching — docs/06 rule 2. */
function jsonDeepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => jsonDeepEqual(v, b[i]!));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) =>
      k === kb[i] && jsonDeepEqual((a as Record<string, JsonValue>)[k]!,
                                   (b as Record<string, JsonValue>)[k]!));
  }
  return false;
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

for (const id of [
  "view:devices.table.selectRows",
  "view:app.navigation.goTo",
  "view:x-ray.sub-panel.readState",
  "domain:devices.disable",
]) {
  assert(decodeWireName(encodeWireName(id)) === id, `codec round-trip ${id}`);
  assert(/^[a-zA-Z0-9_.:-]*$/.test(id), `id alphabet ${id}`);
  assert(/^[a-zA-Z0-9_-]+$/.test(encodeWireName(id)), `wire alphabet ${id}`);
}
assert(encodeWireName("view:devices.table.selectRows") === "view_devices__table__selectRows",
  "codec example from docs/09");

assert(jsonDeepEqual({ deviceIds: ["d1", "d2"] }, { deviceIds: ["d1", "d2"] }), "deep-equal same");
assert(!jsonDeepEqual({ deviceIds: ["d1", "d2"] }, { deviceIds: ["d2", "d1"] }), "order matters");
assert(!jsonDeepEqual({ a: 1 }, { a: 1, b: 2 }), "extra key");
assert(jsonDeepEqual({ a: { b: [1, null, "x"] } }, { a: { b: [1, null, "x"] } }), "nested");

console.log("runtime-checks: all spot checks passed");
