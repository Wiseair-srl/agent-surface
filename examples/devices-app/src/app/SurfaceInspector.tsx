import { useEffect, useState } from "react";
import type {
  AgentConsumer,
  AgentSurfaceRegistry,
  AgentSurfaceSnapshot,
} from "@agent-surface/core";
import { ArrowLeft, Hand } from "./Icons.js";

/**
 * The surface, live.
 *
 * The transcript answers "what did the agent do". This answers the question
 * underneath it — "what CAN it do, right now" — which is the only question
 * this library actually exists to make answerable. It is the registry's own
 * snapshot, unedited: the same object an adapter hands a model, including the
 * capabilities that are visible but not callable and the reason why.
 *
 * Leave it open and select a row in the table: `domain:devices.disable` goes
 * from struck-through with "Select at least one device first" to callable,
 * with its bound-and-locked `deviceIds`. Nothing in the console is doing that
 * — the page is.
 */

function planeOf(capabilityId: string): "view" | "domain" | "meta" {
  if (capabilityId.startsWith("view:")) return "view";
  if (capabilityId.startsWith("domain:")) return "domain";
  return "meta";
}

/** `view:devices.table.readState` → `readState` (the group carries the rest). */
function leafOf(capabilityId: string): string {
  const withoutPlane = capabilityId.replace(/^(view|domain):/, "");
  const dot = withoutPlane.lastIndexOf(".");
  return dot === -1 ? withoutPlane : withoutPlane.slice(dot + 1);
}

function Capability(props: {
  capabilityId: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  tags: React.ReactNode;
}) {
  return (
    <div className={`cap${props.available ? "" : " is-unavailable"}`}>
      <span className={`plane ${planeOf(props.capabilityId)}`}>{planeOf(props.capabilityId)}</span>
      <div>
        <div className="cap-id">{props.name}</div>
        <p className="cap-desc">{props.description}</p>
        {props.available ? (
          <div className="cap-tags">{props.tags}</div>
        ) : (
          <div className="cap-reason">
            <Hand size={13} />
            {props.unavailableReason ?? "not callable right now"}
          </div>
        )}
      </div>
    </div>
  );
}

export function SurfaceInspector(props: {
  registry: AgentSurfaceRegistry;
  consumer: AgentConsumer;
  onBack: () => void;
}) {
  const { registry, consumer } = props;
  const read = (): AgentSurfaceSnapshot =>
    registry.snapshot({ consumer, includeUnavailable: true });
  const [snapshot, setSnapshot] = useState<AgentSurfaceSnapshot>(read);

  // Re-read on every surface change — that is exactly the moment a
  // capability appears, disappears, or changes its availability.
  useEffect(() => {
    setSnapshot(read());
    return registry.subscribe((event) => {
      if (event.type === "surface-changed") setSnapshot(read());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, consumer]);

  const callable =
    snapshot.components.reduce(
      (total, component) =>
        total +
        component.observations.filter((o) => o.available).length +
        component.actions.filter((a) => a.available).length,
      0,
    ) + snapshot.procedures.filter((p) => p.available).length;

  return (
    <div className="subview">
      <div className="subview-head">
        <button className="iconbtn" onClick={props.onBack} aria-label="Back to the transcript">
          <ArrowLeft size={15} />
        </button>
        <span className="subview-title">Surface</span>
        <span className="subview-meta">
          {snapshot.route?.path ?? "/"} · v{snapshot.surfaceVersion} · {callable} callable
        </span>
      </div>

      <div className="subview-body">
        <p className="subview-lead">
          The registry's own snapshot for this consumer. Everything an agent is offered on this
          page — and nothing else. Select a device in the table and watch the domain call below
          become available.
        </p>

        {snapshot.components.map((component) => (
          <section className="cap-group" key={component.registrationId}>
            <div className="cap-group-head">
              <span className="u-kicker">
                {component.type}
                {component.instanceId !== "default" && `@${component.instanceId}`}
              </span>
              <span className="cap-count">
                {component.observations.length + component.actions.length}
              </span>
            </div>

            {component.observations.map((observation) => (
              <Capability
                key={observation.capabilityId}
                capabilityId={observation.capabilityId}
                name={leafOf(observation.capabilityId)}
                description={observation.description}
                available={observation.available}
                {...(observation.unavailableReason
                  ? { unavailableReason: observation.unavailableReason }
                  : {})}
                tags={<span className="tag">observation</span>}
              />
            ))}

            {component.actions.map((action) => (
              <Capability
                key={action.capabilityId}
                capabilityId={action.capabilityId}
                name={leafOf(action.capabilityId)}
                description={action.description}
                available={action.available}
                {...(action.unavailableReason
                  ? { unavailableReason: action.unavailableReason }
                  : {})}
                tags={
                  <>
                    <span className="tag">{action.effect}</span>
                    {action.idempotent && <span className="tag">idempotent</span>}
                    {action.confirmation !== "never" && (
                      <span className="tag warn">confirmation {action.confirmation}</span>
                    )}
                  </>
                }
              />
            ))}
          </section>
        ))}

        {snapshot.procedures.length > 0 && (
          <section className="cap-group">
            <div className="cap-group-head">
              <span className="u-kicker">authoritative</span>
              <span className="cap-count">{snapshot.procedures.length}</span>
            </div>
            {snapshot.procedures.map((procedure) => (
              <Capability
                key={procedure.procedureId}
                capabilityId={procedure.procedureId}
                name={procedure.procedureId.replace(/^domain:/, "")}
                description={procedure.description}
                available={procedure.available}
                {...(procedure.unavailableReason
                  ? { unavailableReason: procedure.unavailableReason }
                  : {})}
                tags={
                  <>
                    <span className="tag">{procedure.effect}</span>
                    {procedure.confirmation !== "never" && (
                      <span className="tag warn">confirmation {procedure.confirmation}</span>
                    )}
                    {procedure.boundFields.map((field) => (
                      <span className="tag bound" key={field.path}>
                        {field.path} bound{field.locked ? " · locked" : ""}
                      </span>
                    ))}
                  </>
                }
              />
            ))}
          </section>
        )}

        {snapshot.components.length === 0 && snapshot.procedures.length === 0 && (
          <p className="subview-lead">
            Nothing is registered on this page, so the agent has no surface here at all. That is
            the default: capabilities exist only where they were explicitly annotated.
          </p>
        )}
      </div>
    </div>
  );
}
