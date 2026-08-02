import { Box, Text, render } from "ink";
import type { CapabilityContractEntry } from "@agent-surface/core";
import type { ContractChange } from "./diff.js";
import type { ContractReport, RenderOptions } from "./report.js";
import {
  contractColumns,
  contractHeading,
  effectRank,
  groupByDeclaration,
  markers,
  sectionTitle,
  showsContract,
  summaryFields,
} from "./report.js";

/**
 * Reach, graded. The drawn view is the one a person reads, so the column that
 * decides how far a capability can act is the column that carries colour.
 */
function effectColor(effect: string): string {
  const rank = effectRank(effect);
  if (rank >= 5) return "red";
  if (rank >= 3) return "yellow";
  if (rank >= 2) return "cyan";
  return "green";
}

function changeColor(change: ContractChange): string {
  if (change.classification === "widening") return "yellow";
  if (change.classification === "narrowing") return "cyan";
  return "gray";
}

function Summary({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const fields = summaryFields(report, options);
  const label = Math.max(...fields.map(([name]) => name.length));
  return (
    <Box flexDirection="column">
      {fields.map(([name, value]) => (
        <Text key={name}>
          <Text dimColor>{name.padEnd(label)}</Text>
          {"  "}
          <Text color={name === "Integrity" && value !== "current" ? "yellow" : undefined}>{value}</Text>
        </Text>
      ))}
    </Box>
  );
}

function Changes({ title, changes }: { title: string; changes: ContractChange[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{sectionTitle(title, changes)}</Text>
      {changes.length === 0 ? (
        <Text dimColor>no changes</Text>
      ) : (
        changes.map((change, index) => (
          <Text key={`${change.capabilityId}\0${change.declarationId}\0${change.field}\0${index}`} color={changeColor(change)}>
            {change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"} {change.classification.padEnd(9)}{" "}
            {change.capabilityId} · {change.field}
          </Text>
        ))
      )}
    </Box>
  );
}

function Capability({
  entry,
  column,
  detail,
}: {
  entry: CapabilityContractEntry;
  column: ReturnType<typeof contractColumns>;
  detail: boolean;
}) {
  const marks = markers(entry, detail);
  return (
    <Box flexDirection="column">
      <Text>
        {"  "}
        {entry.capabilityId.padEnd(column.id)}
        {"  "}
        <Text dimColor>{entry.kind.padEnd(column.kind)}</Text>
        {"  "}
        <Text color={effectColor(entry.effect)}>{entry.effect.padEnd(marks.length > 0 ? column.effect : 0)}</Text>
        {marks.length > 0 ? <Text color="magenta">{`  ${marks.join(" ")}`}</Text> : null}
      </Text>
      {/* Padding rather than a prefix, so a wrapped description stays in its column. */}
      {detail && entry.description ? (
        <Box paddingLeft={6}>
          <Text dimColor>{entry.description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function App({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const ok = report.status === "pass" || report.status === "written" || report.status === "view";
  const column = contractColumns(report.manifest.capabilities);
  return (
    <Box flexDirection="column">
      <Text bold color={ok ? "green" : "red"}>
        AGENT SURFACE {report.command.toUpperCase()} · {report.status.toUpperCase()}
      </Text>
      <Summary report={report} options={options} />
      {report.integrity ? <Changes title="SOURCE ↔ SNAPSHOT" changes={report.integrity.changes} /> : null}
      {report.pullRequest ? (
        <Changes title={`PR DRIFT vs ${report.pullRequest.base}`} changes={report.pullRequest.changes} />
      ) : null}
      {showsContract(report, options) ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{contractHeading(report.manifest)}</Text>
          {groupByDeclaration(report.manifest.capabilities).map((group) => (
            <Box key={group.declarationId} flexDirection="column" marginTop={1}>
              <Text>
                <Text color="blue">{group.declarationId}</Text> <Text dimColor>({group.entries.length})</Text>
              </Text>
              {group.entries.map((entry) => (
                <Capability
                  key={entry.capabilityId}
                  entry={entry}
                  column={column}
                  detail={options.detail === true}
                />
              ))}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export async function renderInk(report: ContractReport, options: RenderOptions = {}): Promise<void> {
  const instance = render(<App report={report} options={options} />);
  await instance.waitUntilExit();
}
