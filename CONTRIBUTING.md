# Contributing to AgentConnect

Thanks for helping improve AgentConnect. This guide covers the development
setup, the pull request conventions, the monorepo layout, and where the deeper
documentation lives. For questions and ideas,
[join the Slack community](https://slack.agentconnect.md) or
[open an issue](https://github.com/agentconnect-md/agentconnect/issues).

## Development setup

Development requires Node >= 24.12.0 and pnpm 11. Docker is required for the
Control Plane integration tests.

```bash
pnpm install
pnpm dev          # run all packages in parallel
pnpm build        # build all packages
pnpm typecheck    # type-check all packages
pnpm lint         # lint the workspace
pnpm format:check # check formatting
pnpm test         # test all packages

# single package
pnpm --filter @agentconnect.md/daemon dev
pnpm --filter @agentconnect.md/control-plane dev
pnpm --filter @agentconnect.md/web dev
```

`pnpm build` builds every package once in dependency order. A package's `build`
command includes its workspace dependencies; `build:package` only compiles that
package and is used when the caller already selects the complete dependency closure.

For a complete local Control Plane and PostgreSQL development setup, follow the
[Control Plane quickstart](packages/control-plane/README.md#local-dev-quickstart).

## Pull requests and issues

Pull request titles and at least one commit must follow the
[Conventional Commits](https://www.conventionalcommits.org) style (`feat: ...`,
`fix: ...`, `docs: ...`); a status check enforces this. Keep changes focused,
and run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before pushing.

The type decides the release: `feat` bumps the minor version and is listed under
Features in the release notes, `fix`, `chore` and `refactor` bump the patch version,
and `docs`, `test` and `ci` do not release. Choose it by who will notice the change,
not by how much code it touches:

- `feat`: a new capability that users or administrators of a release will see and
  that belongs in Features.
- `fix`: something that was wrong for users and now works.
- `chore` or `refactor`: everything internal, such as a deployment or environment
  knob, a convenience for a test environment, tooling, logging, or a small
  adjustment to existing behavior.

When two types fit, use the one that releases less.

Keep fix-related issues open until the fix ships in a stable release. In PR titles,
descriptions, and commit messages, use `Refs #123` or `Related to #123`. Do not pair
issue references with GitHub's closing keywords (`close`, `fix`, `resolve`, or
their variants), or add Development links that close issues on merge. Conventional
commit types such as `fix(scope): ...` are unchanged. Merging a PR or publishing an
RC/prerelease does not complete the issue workflow.

For work split across PRs, each PR states which acceptance items it covers and
what remains. Keep the issue's acceptance checklist and required PR references
current; a partial implementation must not be presented as the complete fix.

For pull requests prepared with an AI coding harness, report the actual harness
and model at the end of the description. Keep any attribution footer the harness
provides and append the model name to its final line. Otherwise, use
`Created by <harness> . <model>` (for example, `Created by Codex . GPT-6`).

## Monorepo layout

This repository is a pnpm workspace. Product packages live under `packages/`:

| Package                               | Path                                                         | Role                                                              |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `@agentconnect.md/cli`                | [`packages/cli`](packages/cli)                               | Stable `agentconnect` entry point, daemon lifecycle, and upgrades |
| `@agentconnect.md/connection`         | [`packages/connection`](packages/connection)                 | Shared WebSocket transport, correlation, backoff, and keepalive   |
| `@agentconnect.md/control-plane`      | [`packages/control-plane`](packages/control-plane)           | Orchestration, registry, authentication, and Web UI BFF           |
| `@agentconnect.md/daemon`             | [`packages/daemon`](packages/daemon)                         | Edge message processing and agent execution unit                  |
| `@agentconnect.md/memory-plugin-mem0` | [`packages/memory-plugin-mem0`](packages/memory-plugin-mem0) | Mem0 Cloud and OSS memory-plugin profiles                         |
| `@agentconnect.md/message`            | [`packages/message`](packages/message)                       | Pure platform message normalization                               |
| `@agentconnect.md/protocol`           | [`packages/protocol`](packages/protocol)                     | Shared daemon, relay, and Control Plane wire contracts            |
| `@agentconnect.md/relay`              | [`packages/relay`](packages/relay)                           | Callback ingress, webchat, and centralized MCP proxy              |
| `@agentconnect.md/setup`              | [`packages/setup`](packages/setup)                           | Browser-based self-hosting and provider App administration        |
| `@agentconnect.md/web`                | [`packages/web`](packages/web)                               | Next.js configuration and monitoring console                      |

## Explore further

- [Public documentation](https://www.agentconnect.md/docs)
- [Documentation index](docs/README.md) — every guide and design document, grouped by area
- [Architecture and detailed designs](docs/designs/)
- [CLI and daemon lifecycle](docs/designs/cli-daemon-split.md)
- [Setup Server](packages/setup/README.md)
- [Daemon configuration](docs/designs/daemon-detailed-design.md)
- [Config-file secrets](docs/config-file-secrets.md)
- [Product conventions](docs/product-conventions.md)
- [Add-on evaluation harness](evals/README.md)
