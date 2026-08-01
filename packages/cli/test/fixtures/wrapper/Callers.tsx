import { usePanel, useNamedPanel } from "./usePanel.js";

/** Two literals through the same wrapper: two component types, one definition. */
export function Devices(): React.ReactElement {
  usePanel("wrap.devices");
  return <div />;
}

export function Billing(): React.ReactElement {
  usePanel("wrap.billing");
  return <div />;
}

export function Named(): React.ReactElement {
  useNamedPanel({ type: "wrap.named" });
  return <div />;
}
