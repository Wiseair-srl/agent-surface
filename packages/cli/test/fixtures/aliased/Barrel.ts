/**
 * A barrel that renames the hook on its way out. Every downstream call site is
 * spelled with a name this extractor cannot tie to a registration API — it
 * would have to follow the re-export chain, which is the one hop the wrapper
 * resolution already refuses to take (`callsWrapper`).
 *
 * So the gap is reported *here*, at the line that opens it, rather than left
 * unsaid at each of the call sites it hides.
 */
export { useAgentComponent as useAC } from "@agent-surface/react";

/** Re-exported under its own name: downstream reads normally, nothing to say. */
export { useAgentObservation } from "@agent-surface/react";
