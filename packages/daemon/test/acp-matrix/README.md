# Local live runtime support matrix

`acp-matrix.test.ts` is a local-machine compatibility suite. It discovers the
runtimes admitted by this daemon installation, launches their real ACP adapters,
and sends real prompts to their configured model providers. It does not use the
scriptable ACP fixture and it does not require Slack.

The suite exercises real lifecycle and memory replies, model and permission-mode
configuration, native resume, interactive permission requests, usage, a sandboxed
provider turn, an HTTP MCP tool call, and a skill installed by the exact bundled
skills CLI.

CI skips this suite. Run it locally with:

```bash
pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

Disposable sessions are removed after each probe when the adapter advertises
ACP `session/delete`; Codex maps that request to a recoverable thread archive.

To limit a diagnostic rerun:

```bash
AC_RUNTIME_MATRIX_TARGETS=codex-acp,opencode \
  pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

To rerun only the sandbox probe and show child-runtime diagnostics:

```bash
AC_RUNTIME_MATRIX_TARGETS=claude-acp AC_RUNTIME_MATRIX_ONLY=sandbox \
  AC_RUNTIME_MATRIX_DEBUG=1 pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

An installed adapter whose provider is logged out, rate-limited, or out of quota
is shown as `U` (provider unavailable), not as a fabricated pass. A feature is
marked `✓` only after the real adapter/provider path completes. A real behavioral
failure is `✗` and fails the test command.
