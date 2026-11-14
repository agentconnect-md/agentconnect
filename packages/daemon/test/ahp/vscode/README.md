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
- A second client then has the agent edit that file, and the editor VS Code holds open shows the new
  content.

VS Code reads files and snapshots only when something asks for them, so after the turns the driver asks
through `vscode.workspace.fs` and `openTextDocument`, which is the path the UI takes.

## Sign-in

`pnpm --filter @agentconnect.md/daemon test:vscode:sign-in` puts the relay's own AHP endpoint in front of
the daemon, with a stand-in for the Control Plane's OAuth server, and loads
[the AgentConnect extension](../../../../vscode/README.md). It then also checks that:

- The extension registered a client, ran the authorization and exchanged the code.
- The relay admitted VS Code with the token the extension issued.
- The extension added the agent's workspace to the Explorer.

The driver passes the sign-in command a fetch in place of the browser, so nothing opens outside VS Code.

The run also prints every method VS Code sent, which is the list to compare against the daemon's
`switch` when VS Code updates.

## Options

- Prompts are arguments: `pnpm --filter @agentconnect.md/daemon test:vscode "first" "second [ahp:edit]"`.
  The runtime's `[ahp:…]` markers are in `test/fixtures/ahp-acp-agent.mjs`.
- `VSCODE_BIN` names the `code` launcher when it is not at the macOS default or on `PATH`.
- `AHP_HARNESS_KEEP=1` keeps the profile, including VS Code's logs, and prints its path.
- To look at the window itself, `AHP_HARNESS_DEBUG_PORT=<port>` opens a DevTools port on that VS Code
  and `AHP_HARNESS_HOLD_MS=<ms>` keeps it open after the checks. A DevTools client can then screenshot
  and click that window alone. `AHP_DRIVER_MOUNT=1` also adds the agent's workspace to the Explorer.

## Limits

- It opens a VS Code window while it runs, and stops VS Code with `pkill`, so it runs on macOS and Linux
  and is not part of `pnpm test` or CI.
- The Control Plane is a stand-in: its token rules, consent page and the relay's grant renewal against
  it are outside the run.
- It drives an editor window. The Agents window also asks the host for a terminal (`createTerminal`),
  which the daemon does not serve.
- It does not answer approval or input prompts, so `[ahp:approve]` and `[ahp:input]` turns do not finish.
- A file change is reported from the agent's own edits, so a file changed by a shell command or by
  another process does not refresh in VS Code.
