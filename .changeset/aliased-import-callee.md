---
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
"@agent-surface/cli": minor
---

Make CLI discovery complete and deterministic.

```tsx
import { useAgentComponent as useAC } from "@agent-surface/react";
useAC({ type: "alias.panel", … });    // was in neither list
```

Aliased/namespaced imports are resolved. First-party workspace program files are scanned; agent-surface implementation files are excluded. Unread allowances now key one semantic site.

One normalized scenario report feeds JSON, snapshots, and checks. It always includes hidden capabilities and removes timestamps, runtime ids, and absolute checkout paths.

Full depth joins the configured authoritative oRPC manifest. Config/CLI scope applies across catalog, runtime, domain, and labels. Rejected registrations fail `check`.

Snapshots write a scenario manifest. Removed/stale scenarios fail; corrupt baselines exit 2; unsafe scenario names are rejected.

### Upgrading

`check` will fail on a codebase that passed before, until you re-accept the surface once. This is the ratchet catching up, not a regression — but it is why this is a minor rather than a patch.

```bash
agent-surface snapshot && git add .agent-surface
```

That covers the first four below. Read the diff before committing it: on a codebase with an aliased or namespaced registration, the catalog is genuinely larger than it was.

- **Baseline documents gained `capabilities` and `rejections`.** Every scenario reports drift until re-snapshotted.
- **`.agent-surface/scenarios.json` is new and required.** Without it `check` reports scenario drift. `snapshot` writes it; commit it.
- **Baseline files for scenarios the config no longer declares now fail.** Delete them.
- **Unread allowances are re-keyed** from `file#reason` to `file#reason#site`. Existing entries in `unresolved-allow.json` read as stale, and a stale entry fails even through `--allow-unresolved`. Re-paste the keys `inspect` prints under each unread entry.
- **Rejected registrations now fail `check`.** Previously they were reported by `inspect` and `--json` only. A duplicate `(type, instanceId)` that CI accepted before will now stop it.
- **A baseline that exists but does not parse exits 2** ("could not run") instead of reading as a missing baseline.
- **Workspace sources outside the config's directory are now analyzed.** Only agent-surface's own implementation packages are excluded, so a monorepo that aliases its app across packages gains authored capabilities — and may gain unreached ones with them.
