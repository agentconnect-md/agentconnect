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

For a complete local Control Plane and PostgreSQL development setup, follow the
[Control Plane quickstart](packages/control-plane/README.md#local-dev-quickstart).

## Pull requests

Pull request titles and at least one commit must follow the
[Conventional Commits](https://www.conventionalcommits.org) style (`feat: ...`,
`fix: ...`, `docs: ...`); a status check enforces this. Keep changes focused,
and run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before pushing.

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

- [Public documentation](https://docs.agentconnect.md)
- [Architecture and detailed designs](docs/designs/)
- [CLI and daemon lifecycle](docs/designs/cli-daemon-split.md)
- [Setup Server](packages/setup/README.md)
- [Daemon configuration](docs/designs/daemon-detailed-design.md)
- [Config-file secrets](docs/config-file-secrets.md)
- [Product conventions](docs/product-conventions.md)
- [Add-on evaluation harness](evals/README.md)
