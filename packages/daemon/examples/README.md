# Public AHP client example

`ahp-client.mjs` uses the official `@microsoft/agent-host-protocol` **1.0.0** client,
WebSocket transport and chat reducer. Node `ws` **8.22.0** supplies the HTTP
authorization header that the browser-style WebSocket constructor cannot set.
The example imports no AgentConnect application, registry or Webchat code.

With repository dependencies installed, run from the repository root:

```sh
export AHP_URL=wss://relay.example.test/ahp/agents/11111111-1111-4111-8111-111111111111
read -rs -p 'Personal API key: ' AHP_API_KEY
export AHP_API_KEY
node packages/daemon/examples/ahp-client.mjs
node packages/daemon/examples/ahp-client.mjs --message 'Say hello.'
node packages/daemon/examples/ahp-client.mjs --session ahp-session:/the-reported-id --message 'Continue.'
unset AHP_API_KEY
```

The hidden `read` command is for Bash. Other shells should inject `AHP_API_KEY`
through their secret-input mechanism. Never put the key in an argument, URL or
checked-in environment file. Deployment connections require TLS; `ws://` is
accepted only for loopback fixtures. Redirects, URL credentials and query strings
are refused. The client offers and verifies only the static `ahp` subprotocol.
See [operations](../../../docs/ahp-operations.md) for the API entry, serving
capability and restricted personal-key canary controls.

To run outside this repository, copy `ahp-client.mjs` into an empty directory and
install its exact dependencies there:

```sh
npm install --save-exact @microsoft/agent-host-protocol@1.0.0 ws@8.22.0
node ahp-client.mjs --help
```

No arguments lists the first 20 authorized sessions. `--message` creates a session
unless `--session` supplies an existing URI. `--session` alone reads its retained
chat snapshot. The URI is printed before creation, allowing a lost receipt to be
reconciled. Output is JSON Lines; each `output.text` replaces the previous text for
that turn. Discovery/history includes a cursor when more records exist; this
minimal CLI does not fetch subsequent pages.

The deadline defaults to 60 seconds (`--timeout 300` changes it). The example
does not approve tools, retry uncertain submissions or reconnect automatically.
SIGINT and timeout detach without cancelling admitted work. Answer approvals
through another authorized client. Inspect the same session before retrying a
disconnected submission. Completion reports protocol turn state, including failure
or cancellation.

The CLI test crosses the actual authenticated relay upgrade route and daemon AHP
connection with fixture authorization and execution. It is separate from full
daemon/ACP acceptance and a deployment run with a real personal key. Neither
fixture proves independently maintained client compatibility; the VS Code /
external-client release gate remains pending.
