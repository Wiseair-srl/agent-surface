import { usePanel } from "./usePanel.js";

/** One caller that does not pass a literal: the rest still resolve, this reports. */
export function Dynamic({ kind }: { kind: string }): React.ReactElement {
  usePanel(kind);
  return <div />;
}
