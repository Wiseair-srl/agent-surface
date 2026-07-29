import type { AgentSurfaceSnapshot } from "@agent-surface/core";

export interface SerializeSurfaceOptions {
  /** Include surfaceVersion in the output. Default false (volatile). */
  includeVersion?: boolean;
}

/**
 * Semantic snapshot serialization (docs/08): registrationIds become stable
 * placeholders in first-appearance order (`<reg#1>`, `<reg#2>` …);
 * surfaceId/capturedAt are dropped; surfaceVersion dropped by default;
 * components/capabilities keep the canonical registry ordering; schemas are
 * included verbatim — schema drift is exactly what these snapshots catch.
 */
export function serializeSurfaceSnapshot(
  snapshot: AgentSurfaceSnapshot,
  options?: SerializeSurfaceOptions,
): Record<string, unknown> {
  const regIdMap = new Map<string, string>();
  const normalizeRegId = (id: string): string => {
    let placeholder = regIdMap.get(id);
    if (!placeholder) {
      placeholder = `<reg#${regIdMap.size + 1}>`;
      regIdMap.set(id, placeholder);
    }
    return placeholder;
  };

  return {
    ...(options?.includeVersion ? { surfaceVersion: snapshot.surfaceVersion } : {}),
    ...(snapshot.route ? { route: snapshot.route } : {}),
    components: snapshot.components.map((component) => ({
      ...component,
      registrationId: normalizeRegId(component.registrationId),
    })),
    procedures: snapshot.procedures.map((procedure) => ({
      ...procedure,
      registrationId: normalizeRegId(procedure.registrationId),
    })),
    ...(snapshot.truncated ? { truncated: snapshot.truncated } : {}),
  };
}
