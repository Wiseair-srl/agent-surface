# Contributing to agent-surface

Thanks for your interest. v0.1 is **implemented in-repo but unpublished**: the normative specification in `docs/` is the source of truth, and the code under `packages/` is built from it. The most valuable contributions right now are security analysis, review of the as-built code against the documented invariants, and adoption feedback from a real application.

## Ground rules

- Be respectful: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security vulnerabilities go through [SECURITY.md](SECURITY.md), never public issues.
- By contributing you agree your contributions are MIT-licensed like the project.

## What to contribute now

| Contribution | How |
|---|---|
| Design review ("this won't work because…") | Open an issue referencing the doc + section; concrete failure scenarios beat opinions |
| Security analysis | Public issue labeled `security-design` for design-level concerns; [SECURITY.md](SECURITY.md) for exploitable specifics |
| Adoption feedback | The abstraction needs [two adoption contexts](docs/12-roadmap.md) before 1.0 — real friction reports are worth more than features |
| Answers to open questions | Comment on the relevant OQ in [13-open-questions.md](docs/13-open-questions.md); a PR resolving one must update that file in the same change |
| Docs fixes | Direct PR |
| Implementation | Claim a milestone-scoped issue ([14-implementation-plan.md](docs/14-implementation-plan.md)); read [17-maintainer-directive.md](docs/17-maintainer-directive.md) first — it is the standing execution contract |

## Working agreements

1. **Docs lead, code follows.** A change to public API, pipeline order, policy semantics, error codes, event names, limits, or security behavior lands as a docs change *in the same PR* as the code. Silent drift between docs and code is a bug in whichever moved without the other.
2. **Decisions are recorded, not remembered.** Behavior invented without an entry in the [decision log](docs/13-open-questions.md) is not mergeable. Correcting a settled decision means a new decision record (see [18-spec-corrections-rfc.md](docs/18-spec-corrections-rfc.md) for the shape).
3. **Every normative requirement has a test.** `spec/conformance.json` maps requirement IDs (`AS-…`) to the test files that prove them; `pnpm check:conformance` fails when an `implemented` requirement has no test, when a test references an unknown ID, or when the error matrix drifts from the implemented enum. New normative behavior needs a new ID and a test mentioning it.
4. **No unbounded collections.** Anything that accumulates at runtime needs a size bound, a lifetime bound, an eviction rule, and a fake-clock test.
5. **No LLM in the test suite.** The surface is a typed contract; contracts are tested deterministically ([08-testing.md](docs/08-testing.md)). Model-based evaluation may supplement conformance tests, never replace them.

## Local development

```bash
pnpm install
pnpm build              # tsup, all packages
pnpm test               # vitest, whole workspace — no network, no model
pnpm typecheck
pnpm check:conformance   # requirement IDs ↔ tests ↔ error matrix
pnpm publint && pnpm size
pnpm bench              # performance baselines (docs/02 §budgets)
pnpm docs:dev           # VitePress
```

CI runs the same commands; a green local run should mean a green pipeline.

## Pull requests

Follow the [PR operating procedure](docs/17-maintainer-directive.md) (§10). In short, state which requirement IDs and decisions the change touches; add or update tests before implementation where feasible; update the normative docs in the same PR; include public type impact for API changes, and security impact for anything touching discovery, invocation, confirmation, or adapters. Avoid unrelated refactors that obscure a protocol change.

Releases are managed with [Changesets](https://github.com/changesets/changesets): run `pnpm changeset` and describe the change from a consumer's point of view. Merging to `main` opens (or updates) a release PR; merging that publishes.
