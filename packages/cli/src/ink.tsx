import { Box, Text, render } from "ink";
import type { CapabilityContractEntry } from "@agent-surface/core";
import type { ContractChange } from "./diff.js";
import type { ContractReport, Reach, RenderOptions } from "./report.js";
import {
  CONTRACT_CAVEAT,
  CONTRACT_HEADERS,
  contractCells,
  contractColumns,
  contractHeading,
  contractLine,
  contractRow,
  groupByDeclaration,
  headline,
  sectionTitle,
  showsContract,
  summaryFields,
} from "./report.js";

/** Colour repeats the REACH word; it never carries the grade on its own. */
const REACH_COLOR: Record<Reach, string> = { low: "green", medium: "yellow", high: "red" };

function changeColor(change: ContractChange): string {
  if (change.classification === "widening") return "yellow";
  if (change.classification === "narrowing") return "cyan";
  return "gray";
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function Summary({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const fields = summaryFields(report, options);
  const label = Math.max(...fields.map(([name]) => name.length));
  return (
    <Box flexDirection="column">
      {fields.map(([name, value]) => (
        <Text key={name}>
          <Text dimColor>{pad(name, label)}</Text>
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
          <Text
            key={`${change.capabilityId}\0${change.declarationId}\0${change.field}\0${index}`}
            color={changeColor(change)}
          >
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
  widths,
  detail,
}: {
  entry: CapabilityContractEntry;
  widths: number[];
  detail: boolean;
}) {
  const row = contractRow(entry);
  const [id, kind, effect, reach, confirm, policies] = contractCells(row);
  return (
    <Box flexDirection="column">
      <Text>
        {"  "}
        {pad(id ?? "", widths[0] ?? 0)}
        {"  "}
        <Text dimColor>{pad(kind ?? "", widths[1] ?? 0)}</Text>
        {"  "}
        <Text dimColor>{pad(effect ?? "", widths[2] ?? 0)}</Text>
        {"  "}
        <Text color={REACH_COLOR[row.reach]}>{pad(reach ?? "", widths[3] ?? 0)}</Text>
        {"  "}
        <Text color={row.confirm === "required" ? "magenta" : undefined} dimColor={row.confirm === "—"}>
          {pad(confirm ?? "", widths[4] ?? 0)}
        </Text>
        {"  "}
        <Text color="magenta" dimColor={row.policies === "—"}>
          {policies}
        </Text>
      </Text>
      {/* Padding rather than a prefix, so a wrapped description stays in its column. */}
      {detail && row.note ? (
        <Box paddingLeft={6}>
          <Text dimColor>{row.note}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function App({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const ok = report.status === "pass" || report.status === "written" || report.status === "view";
  const widths = contractColumns(report.manifest.capabilities);
  const [size, gates] = headline(report.manifest);
  return (
    <Box flexDirection="column">
      <Text bold color={ok ? "green" : "red"}>
        AGENT SURFACE {report.command.toUpperCase()} · {report.status.toUpperCase()}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">
          {size}
        </Text>
        <Text dimColor>{gates}</Text>
      </Box>
      <Box marginTop={1}>
        <Summary report={report} options={options} />
      </Box>
      {report.integrity ? <Changes title="SOURCE ↔ SNAPSHOT" changes={report.integrity.changes} /> : null}
      {report.pullRequest ? (
        <Changes title={`PR DRIFT vs ${report.pullRequest.base}`} changes={report.pullRequest.changes} />
      ) : null}
      {showsContract(report, options) ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{contractHeading(report.manifest)}</Text>
          <Box marginTop={1}>
            <Text dimColor>{`  ${contractLine(CONTRACT_HEADERS, widths)}`}</Text>
          </Box>
          {groupByDeclaration(report.manifest.capabilities).map((group) => (
            <Box key={group.declarationId} flexDirection="column" marginTop={1}>
              <Text>
                <Text color="blue">{group.declarationId}</Text> <Text dimColor>({group.entries.length})</Text>
              </Text>
              {group.entries.map((entry) => (
                <Capability
                  key={entry.capabilityId}
                  entry={entry}
                  widths={widths}
                  detail={options.detail === true}
                />
              ))}
            </Box>
          ))}
          {/* flex-start, or the border stretches to the width of the terminal. */}
          <Box
            flexDirection="column"
            alignSelf="flex-start"
            marginTop={1}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            {CONTRACT_CAVEAT.map((line) => (
              <Text key={line} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export async function renderInk(report: ContractReport, options: RenderOptions = {}): Promise<void> {
  const instance = render(<App report={report} options={options} />);
  await instance.waitUntilExit();
}
