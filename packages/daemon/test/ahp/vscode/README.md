# VS Code against the daemon's AHP host

`pnpm --filter @agentconnect.md/daemon test:vscode` runs the VS Code installed on this machine against
a real `Daemon` and fails when VS Code sends a request the daemon does not support. It needs no sign-in,
no Control Plane and no model, and it leaves your own VS Code windows and profile alone.

It exists because VS Code does not log the method a host refused, so each gap used to surface one at a
time, by hand, as "Unknown method".

## What runs

- [`host.ts`](host.ts) starts the daemon with AHP on, the scripted ACP runtime from the acceptance test
  and a scripted Control Plane metadata boundary, then serves it on a loopback WebSocket with no relay
  and no authentication. It records every frame's method, channel, action type and error, never a payload.
- [`driver/`](driver) is a development extension. Inside VS Code it opens a chat on the remote agent
  host's session type and submits each prompt.
- [`run.ts`](run.ts) starts both in a throwaway profile, waits for the turns, and checks the result.

## Checks

- The driver submitted every prompt and every turn completed.
- No request was answered `Unknown method`, other than the ones listed in `TOLERATED_UNSUPPORTED`.
- VS Code's own log has no chat error and records a successful first response.
- With the default prompts, VS Code's agent-host filesystem lists the workspace, an editor opens a file
  from it, and the edit's before and after snapshots read back as whole files.

VS Code reads files and snapshots only when something asks for them, so after the turns the driver asks
through `vscode.workspace.fs` and `openTextDocument`, which is the path the UI takes.

The run also prints every method VS Code sent, which is the list to compare against the daemon's
`switch` when VS Code updates.

## Options

- Prompts are arguments: `pnpm --filter @agentconnect.md/daemon test:vscode "first" "second [ahp:edit]"`.
  The runtime's `[ahp:…]` markers are in `test/fixtures/ahp-acp-agent.mjs`.
- `VSCODE_BIN` names the `code` launcher when it is not at the macOS default or on `PATH`.
- `AHP_HARNESS_KEEP=1` keeps the profile, including VS Code's logs, and prints its path.

## Limits

- It opens a VS Code window while it runs, and stops VS Code with `pkill`, so it runs on macOS and Linux
  and is not part of `pnpm test` or CI.
- It covers the daemon's protocol surface only. The relay's pre-authentication window and sign-in are
  outside it.
- It does not answer approval or input prompts, so `[ahp:approve]` and `[ahp:input]` turns do not finish.
- `createResourceWatch` is tolerated as unsupported: the daemon serves files read-only without change
  notifications, so a file open in VS Code does not refresh when the agent edits it.
