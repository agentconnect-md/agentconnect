# Native integration configuration in Webchat

## Scope

The built-in administrative MCP exposes `configureIntegration` for creating an
integration or editing an existing one. A trusted declaration of
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

Only the conversation-owned admin connection installs a native-resource resolver.
It checks the tool, resource URI, version and organization. Ordinary provider
connections cannot populate `nativeUi` by returning matching metadata or content.
The daemon emits the existing `app` event with an optional `nativeUi` field through
the relay content stream. Control signaling never carries this interface.

## Hosting and authorization

An entitled built-in Webchat session warms a separate admin MCP Apps host using its
activated remote grant. Connections and template caches are per conversation, not
per organization. The runtime receives hosted tool descriptors through the existing
daemon bridge. It does not also receive the direct admin descriptor when hosting
succeeds. If hosting is unavailable, ordinary administration can fall back to the
existing runtime HTTP descriptor; native configuration requires the hosted path.

Rotation closes the previous connection, and local revocation removes the connection
even if the remote revoke must be retried. Pending dials are invalidated on close.
A change between hosted and direct delivery reloads the runtime session's tool set.
The server retains grant authentication, REST authorization, approval operations and
write idempotency. The host does not implement another administrative authority.

Before opening or reopening a dialog, the card calls the read-only configuration
tool again through its live app RPC. A revoked grant or unavailable target cannot
open an editor. The dialog also checks the active organization and editable agent.
Forms use the human's existing Console authentication; GitHub or another provider
may still require its own installation or authorization flow. No Console credential
is passed to MCP or into an iframe.

## Interaction lifecycle

The first live event opens the dialog, unless another dialog is already open. A
card button allows a later explicit open. App ids are deduplicated in memory and
tab session storage; reconnects and remounts do not repeatedly interrupt the user.
Historical cards contain no live renderer. Closing an editor without submitting
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
