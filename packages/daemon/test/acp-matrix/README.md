# Local live runtime support matrix

`acp-matrix.test.ts` is a local-machine compatibility suite. It discovers the
runtimes admitted by this daemon installation, launches their real ACP adapters,
and sends real prompts to their configured model providers. It does not use the
scriptable ACP fixture and it does not require Slack.

The suite exercises real lifecycle and memory replies, model and permission-mode
configuration, native resume, interactive permission requests, usage, a sandboxed
provider turn, a provider turn inside a microsandbox VM, an HTTP MCP tool call, and
a skill installed by the exact bundled skills CLI.

The VM probe needs Linux with a usable `/dev/kvm` and a built daemon (it stages the
bundled shim), and runs only runtimes the image ships. It boots
`ghcr.io/agentconnect-md/runtime-sandbox-full:latest` unless the daemon config sets
`sandbox.microsandbox.image` or `AC_RUNTIME_MATRIX_VM_IMAGE` names another; the msb
package and image are cached under `$TMPDIR/acm-matrix` between runs.

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

To rerun only the sandbox (or `vm`) probe and show child-runtime diagnostics and
the reason behind every degraded cell:

```bash
AC_RUNTIME_MATRIX_TARGETS=claude-acp AC_RUNTIME_MATRIX_ONLY=sandbox \
  AC_RUNTIME_MATRIX_DEBUG=1 pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

An installed adapter whose provider is logged out, rate-limited, or out of quota
is shown as `U` (provider unavailable), not as a fabricated pass. A feature is
marked `✓` only after the real adapter/provider path completes. A real behavioral
failure is `✗` and fails the test command.

## `sendMessage` probe

`AC_RUNTIME_MATRIX_ONLY=sendMessage` measures how each runtime's model uses
AgentConnect's real messaging tools. The HTTP MCP fixture serves, unmodified, the
descriptors `toolsForIntegrations` returns for an agent with Slack and Telegram
integrations in a Slack session, and the daemon's real standing context with
synthetic ids. A `sendMessage` call runs through the real `executeTool` pipeline up to
its first dependency, so the model reads the daemon's own argument error; when the
served tool takes an `action`, a missing or unknown action and a postless `callAgent`
to itself are also rejected, and a session or task id the scenario's caller does not
own is refused. Accepted calls get a plausible receipt; `getToolGuide`, when served, returns
the real guide. Nothing is posted, woken, or injected.

Each scenario runs in a fresh session: ask a peer for a result, background self-work,
visible work in another channel, a DM, an update in an existing thread, a reply to the
origin session, a negative case answered in the current thread, a request that names the peer
only by its Slack bot mention (only `callAgent` with `needsReply` gets the answer; posting
the mention wakes nobody), a webchat session asking a peer to work in a Slack channel (the
call must name `platform`), and an informational check that the model sees `sendMessage`
and can quote its description's edges. Scenarios run as a Slack thread unless they say
otherwise; a webchat one is served the tools and context a webchat session gets. The
daemon's side-effect-free pre-checks run for real (a wake preflight that admits the call,
and the org's agent bot lookup, where the peer's bot is `U0EXAMPLEPEER`), so a post that
addresses an agent's bot reads the daemon's refusal. Calls
are classified to a semantic operation, so the old target-inferred shape and the
`action` shape are judged alike; `message-task`, which gives an existing background
task more work, is new-only, skipped against the old shape, and kept out of the matrix
cell (its runs carry `comparable: false`). So is `own-work-without-tasks`: the background
self-work request in a session that delegates no task, as a Per thread session is once only
an Auto conversation's coordinator delegates ([auto-session-mode.md](../../../../docs/designs/auto-session-mode.md)
§5.1). It is served that session's tools and standing context, and passes with no
`sendMessage` call.

A scenario passes when the first `sendMessage` call is valid and correct, is
degraded (`·`) when only the last call is, and fails (`✗`) otherwise or on any call in
the negative case. `U` means the provider was unavailable.

```bash
AC_RUNTIME_MATRIX_ONLY=sendMessage \
  AC_RUNTIME_MATRIX_SENDMESSAGE_OUT=/tmp/send-message-baseline.json \
  pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

- `AC_RUNTIME_MATRIX_SENDMESSAGE_REPS` repeats every scenario (default 1).
- `AC_RUNTIME_MATRIX_SENDMESSAGE_SCENARIOS` limits the run to a comma list of scenario ids.
- `AC_RUNTIME_MATRIX_SENDMESSAGE_OUT` receives the JSON report — git head, descriptor
  sizes and tool names, and per run the verdict, classified operations, call counts,
  wall time, and token usage — even when cells fail. It is rewritten after every run,
  and this mode's test timeout grows with targets × scenarios × repetitions.

## Coordinator probe

`AC_RUNTIME_MATRIX_ONLY=coordinator` checks whether each runtime's model can act as the
`auto` session mode's coordinator ([auto-session-mode.md](../../../../docs/designs/auto-session-mode.md)).
It injects the candidate coordinator prompt and tool surface from `coordinator-probe.ts`
(`sendMessage` with `delegateTask`, `messageTask` and `replyToMessage`, plus `listTasks`)
through its own HTTP MCP fixture, delivers channel-root messages one or several per turn,
and judges each message's outcome: handed to an open task, a new task, a direct reply, or
ignored. A refused call (an unknown message or task id, a second outcome for a message)
reads the fixture's error and degrades the run. Nothing is posted or started.

```bash
AC_RUNTIME_MATRIX_ONLY=coordinator AC_RUNTIME_MATRIX_TARGETS=claude-acp,codex-acp \
  pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

- `AC_RUNTIME_MATRIX_COORDINATOR_REPS` repeats every scenario (default 1).
- `AC_RUNTIME_MATRIX_COORDINATOR_SCENARIOS` limits the run to a comma list of scenario ids.
- `AC_RUNTIME_MATRIX_COORDINATOR_OUT` receives the JSON report: the prompt, the tools, and
  per run the verdict, outcomes, every tool call's title, wall time and token usage.
