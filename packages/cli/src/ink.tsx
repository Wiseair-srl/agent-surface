import { Box, Text, render } from "ink";
import type { ContractReport } from "./report.js";
import { changeCounts } from "./diff.js";

function App({ report }: { report: ContractReport }) {
  const ok = report.status === "pass" || report.status === "written" || report.status === "view";
  return (
    <Box flexDirection="column">
      <Text bold color={ok ? "green" : "red"}>
        AGENT SURFACE {report.command.toUpperCase()} · {report.status.toUpperCase()}
      </Text>
      <Text>Contract      {report.manifest.hash}</Text>
      <Text>Completeness  {report.manifest.completeness.status}</Text>
      <Text>Capabilities  {report.manifest.capabilities.length}</Text>
      {report.integrity ? <Text>Integrity     {report.integrity.status}</Text> : null}
      {report.pullRequest ? (
        <Text>
          PR drift      {report.pullRequest.changes.length} vs {report.pullRequest.base} ({
            changeCounts(report.pullRequest.changes).widening
          } widening)
        </Text>
      ) : null}
    </Box>
  );
}

export async function renderInk(report: ContractReport): Promise<void> {
  const instance = render(<App report={report} />);
  await instance.waitUntilExit();
}
