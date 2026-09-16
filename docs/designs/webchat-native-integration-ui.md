# Native integration configuration in Webchat

## Scope

The built-in administrative MCP exposes `configureIntegration` for creating an
integration or editing an existing one. A versioned presentation intent naming
`ui://agentconnect/integration-setup` maps to a Console React dialog. This path
does not fetch an HTML template and does not create an iframe. Other MCP Apps
continue to use the sandboxed iframe renderer.

Creation reuses the existing platform wizard, optionally preselecting the provider
and an editable agent. Editing a chat integration configures its conversation
triggers. Editing a code-host subscription configures its name, enabled state,
event cadence and supported review settings. Repository identity and subject family
stay fixed; another repository or family is added through the creation flow.

GitHub, GitLab and Gitea remain code hosts, not chat platform modules. Their edit
targets use `kind: codehost-subscription`; chat bindings use `kind: integration`.
An edit requires both the target id and its owning agent id. The MCP tool resolves
them through the existing authenticated REST reads before returning an intent.

## Tool and wire contract

Examples:

```json
{ "mode": "create", "provider": "github", "agentId": "<uuid>" }
```

```json
{ "mode": "edit", "agentId": "<uuid>", "target": { "kind": "codehost-subscription", "id": "<uuid>" } }
```

The tool is read-only: it opens an editor without submitting any changes. Its
descriptor declares `_meta.ui.resourceUri`. The result contains a strict,
versioned `NativeMcpUi` value with the organization id and validated intent.
Unknown arguments, including credentials, HTML and caller-selected organization
ids, are rejected. The server supplies the organization from authentication.

The result includes the intent in both `structuredContent` and a text content block.
The runtime calls admin MCP directly over HTTP and reports its normal ACP tool result.
The daemon projects a successful, schema-valid result into the existing `app` event
with `nativeUi`, through the relay content stream. It neither calls admin MCP nor
reads resources. Control signaling never carries this interface. Failed and incomplete
tool calls do not open dialogs; repeated updates for one call open at most one card.

## Hosting and authorization

An entitled built-in Webchat session receives the direct HTTP admin MCP descriptor
with its activated conversation grant. There is no administrative MCP Apps host,
connection cache, tool re-publication or stdio forwarding. Generic HTML MCP Apps
continue using their existing host, independently of native integration configuration.

Grant rotation, revocation and runtime descriptor refresh retain their original direct
HTTP behavior. The server retains grant authentication, REST authorization, approval
operations and write idempotency.

An intent requests presentation, not authority. No signature, source registry or
second MCP call is needed before opening a dialog. The dialog checks the active
organization and editable agent, and every data read and write uses the current
human's Console JWT and existing server-side authorization. A matching result from
another tool grants no extra access. The schema accepts no arbitrary HTML or URL.
Native cards cannot call MCP tools or read MCP resources. GitHub or another provider
may still require its own installation or authorization flow. No Console credential
is passed to MCP or into an iframe.

## Interaction lifecycle

The first live event opens the dialog, unless another dialog is already open. A
card button allows a later explicit open. App ids are deduplicated in memory and
tab session storage; reconnects and remounts do not repeatedly interrupt the user.
The transcript preserves the validated native intent. Refreshing or disconnecting releases
the old stream without expiring the card; an authorized, connected reader can reopen
it and send completion through a restored native-only handler. Closed, completed,
superseded, or session-expired cards remain inactive. Read-only history never opens
a dialog. Closing an editor without submitting
does not send a completion message. A card becoming inactive closes its own dialog.

Successful saves produce a bounded, non-secret summary through the existing
`ui/message` path. The daemon dispatches it as an ordinary user turn and settles the
configuration card as `completed` after admission. The transcript records that
outcome and summary. UI completion callbacks are deduplicated; opening a form is
never reported as creating an integration.

Code-host edits preserve custom event subscriptions unless the user explicitly
changes cadence. The dialog checks the latest configuration revision before a
whole-definition update. This is a stale-form check, not a transactional compare
and swap: the existing REST endpoint remains authoritative. Multi-conversation
edits and external provider authorization can partially succeed; errors must not
claim those earlier operations were rolled back. Existing provider credentials,
OAuth codes and tokens never enter the completion summary.

## Runtime verification

A local probe using Codex ACP `1.11.0-agentconnect.1` in protected full-access mode
successfully called a mock HTTP admin MCP. Its `tool_call_update.rawOutput.result`
preserved `content`, `structuredContent` and `_meta`, along with `rawInput.server`
and `rawInput.tool`. This establishes the direct result path for that runtime;
other adapters must preserve a structured result or the text JSON content block.
The earlier stdio-proxy design failed before `configureIntegration`: that runtime's
full-access HTTP approval policy cancelled `whoami` on the stdio bridge.
