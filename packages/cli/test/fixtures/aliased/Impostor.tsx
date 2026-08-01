/**
 * A local function that happens to be spelled like another file's alias of the
 * hook. Import bindings are per file, so nothing here says `useAC` is ours —
 * and resolving it would put `alias.impostor` in the catalog with capabilities
 * no component authors. Fabricating an entry is the failure this package has
 * never had; a missing one is the failure it reports.
 */
function useAC(_config: { type: string; actions: Record<string, unknown> }): void {
  /* not a registration at all */
}

export function Impostor(): React.ReactElement {
  useAC({ type: "alias.impostor", actions: { poke: {} } });
  return <div />;
}
