import { Box, Text, render } from "ink";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import type { ContractChange } from "./diff.js";
import type { ContractReport, ContractRow, RenderOptions } from "./report.js";
import {
  CONTRACT_CAVEAT,
  CONTRACT_CAVEAT_SHORT,
  CONTRACT_HEADERS,
  EFFECT_COLOR,
  REACH_COLOR,
  changeStyle,
  confirmStyle,
  contractCells,
  contractColumns,
  contractHeading,
  contractLine,
  contractRow,
  contractView,
  displayPath,
  groupByDeclaration,
  headline,
  integrityWord,
  sectionTitle,
  summaryFields,
  verbosityOf,
} from "./report.js";

/**
 * The drawn twin of `humanReport`: same blocks, same words, same colour
 * vocabulary — colour repeats a word, it never carries the fact alone.
 */

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

/** Ink takes the style names as colours; "dim" alone maps to dimColor. */
function Cell({ text, style }: { text: string; style?: string | undefined }) {
  if (!style) return <Text>{text}</Text>;
  if (style === "dim") return <Text dimColor>{text}</Text>;
  return <Text color={style}>{text}</Text>;
}

function Summary({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const fields = summaryFields(report, options);
  const label = Math.max(...fields.map(([name]) => name.length));
  return (
    <Box flexDirection="column" marginTop={1}>
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

function Changes({ title, changes, rows }: { title: string; changes: ContractChange[]; rows: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{sectionTitle(title, changes)}</Text>
      {!rows ? null : changes.length === 0 ? (
        <Text dimColor>no changes</Text>
      ) : (
        changes.map((change, index) => (
          <Text
            key={`${change.capabilityId}\0${change.declarationId}\0${change.field}\0${index}`}
            color={changeStyle(change)}
          >
            {change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"} {change.classification.padEnd(9)}{" "}
            {change.capabilityId} · {change.field}
          </Text>
        ))
      )}
    </Box>
  );
}

function Row({ row, widths, indent }: { row: ContractRow; widths: number[]; indent: string }) {
  const [id, kind, effect, reach, confirm, policies] = contractCells(row);
  return (
    <Text>
      {indent}
      {pad(id ?? "", widths[0] ?? 0)}
      {"  "}
      <Cell text={pad(kind ?? "", widths[1] ?? 0)} style="dim" />
      {"  "}
      <Cell text={pad(effect ?? "", widths[2] ?? 0)} style={EFFECT_COLOR[row.effect]} />
      {"  "}
      <Cell text={pad(reach ?? "", widths[3] ?? 0)} style={REACH_COLOR[row.reach]} />
      {"  "}
      <Cell text={pad(confirm ?? "", widths[4] ?? 0)} style={confirmStyle(row.confirm)} />
      {"  "}
      <Cell text={policies ?? ""} style={row.policies === "—" ? "dim" : undefined} />
    </Text>
  );
}

function FlatContract({ manifest }: { manifest: CapabilityContractManifest }) {
  const widths = contractColumns(manifest.capabilities);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{contractLine(CONTRACT_HEADERS, widths)}</Text>
      {manifest.capabilities.map((entry) => (
        <Row key={`${entry.declarationId}\0${entry.capabilityId}`} row={contractRow(entry)} widths={widths} indent="" />
      ))}
    </Box>
  );
}

function GroupedContract({ manifest }: { manifest: CapabilityContractManifest }) {
  const widths = contractColumns(manifest.capabilities);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{contractHeading(manifest)}</Text>
      <Box marginTop={1}>
        <Text dimColor>{`  ${contractLine(CONTRACT_HEADERS, widths)}`}</Text>
      </Box>
      {groupByDeclaration(manifest.capabilities).map((group) => (
        <Box key={group.declarationId} flexDirection="column" marginTop={1}>
          <Text>
            <Text color="blue">{group.declarationId}</Text> <Text dimColor>({group.entries.length})</Text>
          </Text>
          {group.entries.map((entry) => (
            <Capability key={entry.capabilityId} entry={entry} widths={widths} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Capability({ entry, widths }: { entry: CapabilityContractEntry; widths: number[] }) {
  const row = contractRow(entry);
  return (
    <Box flexDirection="column">
      <Row row={row} widths={widths} indent="  " />
      {/* Padding rather than a prefix, so a wrapped description stays in its column. */}
      {row.note ? (
        <Box paddingLeft={6}>
          <Text dimColor>{row.note}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Caveat({ lines, boxed }: { lines: readonly string[]; boxed: boolean }) {
  if (!boxed) {
    return (
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    // flex-start, or the border stretches to the width of the terminal.
    <Box flexDirection="column" alignSelf="flex-start" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      {lines.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function App({ report, options }: { report: ContractReport; options: RenderOptions }) {
  const ok = report.status !== "fail";
  const verbosity = verbosityOf(options);
  const view = contractView(report, options);
  const [size, gates] = headline(report.manifest);
  const integrity = integrityWord(report);
  const stale = report.integrity && report.integrity.status !== "current";
  const banner = report.command !== "inspect" || verbosity === "detail";
  const rows = verbosity !== "min";
  const showIntegrity =
    report.integrity !== undefined &&
    (report.command === "check" || verbosity === "detail" || report.integrity.changes.length > 0);
  return (
    <Box flexDirection="column">
      {banner ? (
        <Box marginBottom={1}>
          <Text bold color={ok ? "green" : "red"}>
            AGENT SURFACE {report.command.toUpperCase()} · {report.status.toUpperCase()}
          </Text>
        </Box>
      ) : null}
      <Text bold>{size}</Text>
      <Text>
        <Text dimColor>{gates}</Text>
        {integrity ? (
          <>
            <Text dimColor> · </Text>
            <Text color={stale ? "yellow" : undefined} dimColor={!stale}>
              {integrity}
            </Text>
          </>
        ) : null}
      </Text>
      {report.command === "snapshot" ? (
        <Box marginTop={1}>
          <Text>wrote {displayPath(report.snapshotPath, options.root)}</Text>
        </Box>
      ) : null}
      {verbosity === "detail" ? <Summary report={report} options={options} /> : null}
      {showIntegrity && report.integrity ? (
        <Changes title="SOURCE ↔ SNAPSHOT" changes={report.integrity.changes} rows={rows} />
      ) : null}
      {report.pullRequest ? (
        <Changes title={`PR DRIFT vs ${report.pullRequest.base}`} changes={report.pullRequest.changes} rows={rows} />
      ) : null}
      {view === "flat" ? <FlatContract manifest={report.manifest} /> : null}
      {view === "grouped" ? <GroupedContract manifest={report.manifest} /> : null}
      {view === "flat" ? <Caveat lines={CONTRACT_CAVEAT_SHORT} boxed={false} /> : null}
      {view === "grouped" ? <Caveat lines={CONTRACT_CAVEAT} boxed /> : null}
    </Box>
  );
}

export async function renderInk(report: ContractReport, options: RenderOptions = {}): Promise<void> {
  const instance = render(<App report={report} options={options} />);
  await instance.waitUntilExit();
}
