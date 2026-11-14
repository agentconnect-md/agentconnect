# AgentConnect for VS Code

Signs VS Code in to AgentConnect agents served over AHP, and adds an agent's workspace to the Explorer.

VS Code opens an agent as a remote agent host, but it signs in to one only through an authentication
provider it already has. This extension is that provider: it signs you in through the Control Plane's
OAuth server in your browser and hands VS Code the token.

It is a preview distributed as a VSIX on the repository's releases. It uses VS Code's proposed `authIssuers` API, which VS Code
allows only for extensions you name at startup, so it cannot be published to the Marketplace yet.

## Install

1. Download `agentconnect-vscode.vsix` from the
   [latest release](https://github.com/agentconnect-md/agentconnect/releases/latest/download/agentconnect-vscode.vsix).
   Each stable release carries it under its own version. To build it from a checkout instead, run
   `pnpm --filter agentconnect-vscode package`, which needs the `zip` command.

2. Install it:

   ```bash
   code --install-extension agentconnect-vscode.vsix
   ```

3. Allow its proposed API. Run **Preferences: Configure Runtime Arguments** and add the extension's id to
   `argv.json`, then restart VS Code:

   ```json
   { "enable-proposed-api": ["agentconnect.agentconnect-vscode"] }
   ```

## Use

1. Add the agent's endpoint, `wss://relay.example.test/ahp/agents/<agent-id>`, as a remote agent host:
   in an editor window, under `chat.workspaceRemoteAgentHosts` in a trusted folder's
   `.vscode/settings.json`; in the Agents window, with **Add Remote Agent Host...**.
2. Run **AgentConnect: Sign In to an Agent**, sign in to the console in the browser and approve.
3. Start a chat with the agent.

| Command                                                    | What it does                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **AgentConnect: Sign In to an Agent**                      | Signs in to a configured agent endpoint.                                                  |
| **AgentConnect: Sign Out**                                 | Forgets every stored sign-in.                                                             |
| **AgentConnect: Add an Agent's Workspace to the Explorer** | Adds a session's working directory as a read-only folder. Open that session's chat first. |

The **AgentConnect** output channel logs registration, sign-in and refresh.

## How it works

- On startup it sends an unauthenticated `initialize` to each configured endpoint and reads the
  resource, authorization server and scopes the relay advertises. No setting names a server.
- Sign-in is authorization code with PKCE over a loopback redirect, after RFC 7591 registration. The
  client id is kept per authorization server.
- Tokens live in VS Code's secret storage and are rotated five minutes before they expire.
- The workspace command lists your sessions on the endpoint as a second AHP client, then adds the
  chosen directory under VS Code's own agent-host filesystem.

## Limits

- One sign-in per agent, because the Control Plane binds a grant to one endpoint. VS Code asks a
  provider by authorization server and scope only, so with several agents signed in on one deployment
  it receives the most recent token, and the other agents refuse it.
- Two VS Code windows can race to rotate the same refresh token; the loser signs in again.
- The Explorer folder shows files only while VS Code holds that session, and it relies on the URI
  shape of VS Code's agent-host filesystem, which is not a public API.

## Test

`pnpm --filter agentconnect-vscode test` covers the OAuth flow, the provider and the AHP helper
against stand-ins. `pnpm --filter @agentconnect.md/daemon test:vscode:sign-in` runs the installed
VS Code with this extension against the relay's AHP endpoint and a daemon
([harness](../daemon/test/ahp/vscode/README.md)).
