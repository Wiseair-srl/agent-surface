/**
 * A DIFFERENT function that happens to share the wrapper's name. Resolving this
 * call site against the real wrapper would put `wrap.impostor` in the catalog
 * with capabilities no component authors — fabricating an entry, which is worse
 * than reporting nothing. It must not be attributed.
 */
function usePanel(_type: string): void {
  /* not a registration at all */
}

export function Impostor(): React.ReactElement {
  usePanel("wrap.impostor");
  return <div />;
}
