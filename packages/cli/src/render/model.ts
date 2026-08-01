import type {
  AgentActionDescriptor,
  AgentObservationDescriptor,
  AgentProcedureDescriptor,
  AgentSurfaceSnapshot,
} from "@agent-surface/core";
import type { CapabilityExplanation, SurfaceExplanation } from "@agent-surface/core/explain";
import type { CollectResult, RegistrationRejection } from "../collect.js";

/**
 * One view model, two renderers. The Ink UI and the plain-text fallback both
 * consume this, so `--plain` can never drift into showing something different
 * from what a TTY shows.
 */
export interface CapabilityRow {
  capabilityId: string;
  /** Leaf name — the group heading already carries the rest of the id. */
  name: string;
  /**
   * The id minus its plane prefix. The table is flat, so its first column has
   * to carry the whole path; the grouped detail view uses `name`.
   */
  path: string;
  kind: "observation" | "action" | "procedure";
  plane: "view" | "domain";
  outcome: "expose" | "disable" | "hide";
  description: string;
  reason?: string;
  /** The effect, alone, for the table's own column. Observations have none. */
  effect?: string;
  /** What is left of `tags` once the effect has its own column. */
  flags: string[];
  /** Effect and flags together — what the grouped detail view prints. */
  tags: string[];
  policies?: CapabilityExplanation["policies"];
  availability?: CapabilityExplanation["availability"];
  schemas?: { input?: unknown; output?: unknown };
}

export interface CapabilityGroup {
  heading: string;
  rows: CapabilityRow[];
}

export interface SurfaceView {
  scenario: string;
  route?: string;
  /**
   * The scope the counts below were computed under (`AS-CLI-007`). A scope
   * filters the snapshot *and* the explanation, so without it on screen the
   * header reads as a statement about the whole surface when it is a statement
   * about one prefix of it.
   */
  scope?: string[];
  groups: CapabilityGroup[];
  counts: { callable: number; disabled: number; hidden: number };
  /** Refused during the mount — absent from both projections (`AS-CLI-006`). */
  rejections: RegistrationRejection[];
  explained: boolean;
}

export interface ViewOptions {
  explain?: boolean;
  schemas?: boolean;
}

/**
 * The table is flat — `groups` exist for the grouped detail view, which is what
 * `--detail`, `--explain` and `--schemas` render. Flattening here rather than in
 * each renderer keeps the two views over one order.
 */
export function flatRows(view: SurfaceView): CapabilityRow[] {
  return view.groups.flatMap((group) => group.rows);
}

function pathOf(capabilityId: string): string {
  return capabilityId.replace(/^(view|domain):/, "");
}

function leafOf(capabilityId: string): string {
  const withoutPlane = pathOf(capabilityId);
  const dot = withoutPlane.lastIndexOf(".");
  return dot === -1 ? withoutPlane : withoutPlane.slice(dot + 1);
}

/**
 * The effect gets its own table column; everything else is a flag. An
 * observation reads state and has no effect at all, which the table shows as
 * an em dash rather than inventing one.
 */
function actionFlags(action: AgentActionDescriptor): string[] {
  const flags: string[] = [];
  if (action.idempotent) flags.push("idempotent");
  if (action.reversible) flags.push("reversible");
  if (action.confirmation !== "never") flags.push(`confirmation:${action.confirmation}`);
  return flags;
}

function procedureFlags(procedure: AgentProcedureDescriptor): string[] {
  const flags: string[] = [];
  if (procedure.confirmation !== "never") flags.push(`confirmation:${procedure.confirmation}`);
  for (const field of procedure.boundFields) {
    flags.push(`${field.path} bound${field.locked ? "+locked" : ""}`);
  }
  return flags;
}

function explanationIndex(explanation: SurfaceExplanation): Map<string, CapabilityExplanation> {
  const index = new Map<string, CapabilityExplanation>();
  for (const capability of explanation.capabilities) {
    // Keyed by id + registration so two instances of one component stay apart.
    index.set(`${capability.capabilityId}\u0000${capability.registrationId}`, capability);
  }
  return index;
}

export function buildView(result: CollectResult, options: ViewOptions = {}): SurfaceView {
  const { snapshot, explanation } = result;
  const index = explanationIndex(explanation);
  const groups: CapabilityGroup[] = [];
  const counts = { callable: 0, disabled: 0, hidden: 0 };

  const enrich = (
    row: CapabilityRow,
    capabilityId: string,
    registrationId: string,
  ): CapabilityRow => {
    const explained = index.get(`${capabilityId}\u0000${registrationId}`);
    if (options.explain && explained) {
      row.policies = explained.policies;
      row.availability = explained.availability;
    }
    return row;
  };

  for (const component of snapshot.components) {
    const rows: CapabilityRow[] = [];

    for (const observation of component.observations) {
      rows.push(
        enrich(
          rowFor(observation, "observation", undefined, [], options, {
            input: undefined,
            output: observation.outputSchema,
          }),
          observation.capabilityId,
          component.registrationId,
        ),
      );
    }
    for (const action of component.actions) {
      rows.push(
        enrich(
          rowFor(action, "action", action.effect, actionFlags(action), options, {
            input: action.inputSchema,
            output: action.outputSchema,
          }),
          action.capabilityId,
          component.registrationId,
        ),
      );
    }

    groups.push({
      heading:
        component.instanceId === "default"
          ? component.type
          : `${component.type}@${component.instanceId}`,
      rows,
    });
  }

  if (snapshot.procedures.length > 0) {
    groups.push({
      heading: "authoritative (domain)",
      rows: snapshot.procedures.map((procedure) =>
        enrich(
          {
            capabilityId: procedure.procedureId,
            name: procedure.procedureId.replace(/^domain:/, ""),
            path: pathOf(procedure.procedureId),
            kind: "procedure",
            plane: "domain",
            outcome: procedure.available ? "expose" : "disable",
            description: procedure.description,
            ...(procedure.unavailableReason ? { reason: procedure.unavailableReason } : {}),
            effect: procedure.effect,
            flags: procedureFlags(procedure),
            tags: [procedure.effect, ...procedureFlags(procedure)],
            ...(options.schemas
              ? { schemas: { input: procedure.inputSchema, output: procedure.outputSchema } }
              : {}),
          },
          procedure.procedureId,
          procedure.registrationId,
        ),
      ),
    });
  }

  // Hidden capabilities exist only in the explanation — that is the whole point
  // of it. They get their own group so nobody mistakes them for callable.
  //
  // Unconditional, not behind `--explain`, for the reason `AS-CLI-007` moved
  // the hidden *count* out from behind it: signed out, the example app rendered
  // `0 callable, 0 visible-disabled` over eleven perfectly good capabilities
  // that authority had hidden, and a reader who did not know to re-run with a
  // flag read that as an app which annotated nothing. The explanation is
  // collected on every run regardless, so this costs nothing. The policy
  // *attribution* still needs `--explain`; only the rows moved.
  const hidden = explanation.capabilities.filter((c) => c.outcome === "hide");
  if (hidden.length > 0) {
    groups.push({
      heading: "hidden by policy (absent from the snapshot)",
      rows: hidden.map((capability) => ({
        capabilityId: capability.capabilityId,
        name: leafOf(capability.capabilityId),
        path: pathOf(capability.capabilityId),
        kind: capability.kind,
        plane: capability.plane,
        outcome: "hide" as const,
        description: capability.description,
        // No reason line, deliberately. The reason a hidden capability carries
        // is its *availability* reason — "The drawer is not open" — and printing
        // that under a row marked `hidden` says the UI declined when authority
        // did. Authority hides, state discloses (D11/D12), and the two must
        // never look alike. Why it was hidden is a policy question, which is
        // what `--explain` answers.
        //
        // A hidden capability has no snapshot entry, so there is no effect to
        // report — the table prints an em dash rather than inventing one. The
        // capability path already carries the component type; only a non-default
        // instance adds anything.
        flags:
          capability.component.instanceId === "default"
            ? []
            : [`@${capability.component.instanceId}`],
        tags: [`${capability.component.type}@${capability.component.instanceId}`],
        ...(options.explain
          ? { policies: capability.policies, availability: capability.availability }
          : {}),
      })),
    });
  }

  for (const capability of explanation.capabilities) {
    if (capability.outcome === "expose") counts.callable += 1;
    else if (capability.outcome === "disable") counts.disabled += 1;
    else counts.hidden += 1;
  }

  return {
    scenario: result.scenario,
    ...(snapshot.route?.path ? { route: snapshot.route.path } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
    groups,
    counts,
    rejections: result.rejections ?? [],
    explained: options.explain === true,
  };
}

function rowFor(
  descriptor: AgentObservationDescriptor | AgentActionDescriptor,
  kind: "observation" | "action",
  effect: string | undefined,
  flags: string[],
  options: ViewOptions,
  schemas: { input?: unknown; output?: unknown },
): CapabilityRow {
  return {
    capabilityId: descriptor.capabilityId,
    name: descriptor.name,
    path: pathOf(descriptor.capabilityId),
    kind,
    plane: "view",
    outcome: descriptor.available ? "expose" : "disable",
    description: descriptor.description,
    ...(descriptor.unavailableReason ? { reason: descriptor.unavailableReason } : {}),
    ...(effect ? { effect } : {}),
    flags,
    // The grouped detail view prints one combined list, the way it always has.
    tags: effect ? [effect, ...flags] : [kind, ...flags],
    ...(options.schemas ? { schemas } : {}),
  };
}
