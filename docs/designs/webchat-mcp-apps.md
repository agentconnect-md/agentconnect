# Webchat MCP Apps — agent-authored interfaces in the console

Status: v1 implemented. Closes the webchat half of
[#1966](https://github.com/agentconnect-md/agentconnect/issues/1966).

## 1. Summary

An MCP server may ship an interactive HTML interface for one of its tools
(**MCP Apps**, the first official MCP extension — SEP-1865, Final 2026-01-26). The
server predeclares the interface as a `ui://` resource with mime type
`text/html;profile=mcp-app`, links it to a tool through `_meta.ui.resourceUri`, and
the **host** renders it in a sandboxed iframe that talks back over MCP's own JSON-RPC.

This design makes **AgentConnect the MCP Apps host, and webchat the only surface that
renders one.** That is not a staging decision that a later revision walks back: an
iframe cannot live inside a Slack message, a Telegram inline keyboard, a Discord modal
or a Feishu card, and no variation of MCP Apps changes that. #1966 records the survey;
§2 records the consequence we accept.

The three things this document decides:

- **Who hosts.** The daemon, not the runtime (§3). This is the only place the HTML can
  be obtained at all, and the reason is structural rather than preferential.
- **Where it renders, and what happens elsewhere.** Webchat renders; every other
  surface declines out loud through the mechanism #1794 already built, and the turn
  still completes (§6).
- **What the iframe is allowed to be.** An opaque origin with no console storage, no
  console credentials, and a host-built CSP (§7). This narrows the spec deliberately.

## 2. The webchat-only clause, stated on purpose

#1966's open question was whether a rich-UI layer should be A2UI (a declarative
component tree, portable onto the four chat surfaces) or MCP Apps (HTML in an iframe,
structurally webchat-only). This design takes MCP Apps **and accepts that it is a
webchat feature forever**, which is exactly the failure mode #1966 warned about —
"letting it become one by accident" — avoided by saying it once, here:

- No `WebchatPlatformModule`-shaped generalization is planned or wanted. MCP Apps is
  **not** a fifth `ElicitCardFacet` implementer, and a future chat surface does not
  "still need" an app renderer.
- A portable rich-UI layer, if it is ever wanted, is a **separate** layer (A2UI is the
  candidate), and it would render through the elicitation-card seam the primitives
  already use. The two would coexist; neither subsumes the other.
- The seam this feature is allowed to touch is therefore the **webchat event stream**
  and the **daemon's MCP proxy** — not `platforms/elicit-card.ts`, not
  `platform-manifest.ts`, and not any per-platform module. A capability flag saying
  "can render an app" would have exactly one true value forever, which is a constant
  wearing a manifest field's clothes.

What the other surfaces get is the DECLINE, and it is the pattern #1794 already
settled: the surface says what it cannot show, in the channel, as a standing line.

## 3. Why the daemon hosts, and the runtime cannot

MCP servers configured on a daemon are attached to the **runtime** today:
`resolveAgentMcpServers` (`daemon/src/mcp/resolve-servers.ts`) turns each enabled
definition into an ACP `McpServer` entry at `session/new`, and the runtime — Claude
Code, Codex — is the MCP client that dials it. Follow the HTML from there and it never
arrives:

1. MCP Apps is **capability-negotiated**. A server registers UI-enabled tools only
   after the client advertises
   `capabilities.extensions["io.modelcontextprotocol/ui"]`. No ACP runtime does.
2. The HTML is **not in the tool result**. `_meta.ui.resourceUri` is a pointer; the
   host fetches the template with `resources/read`. A runtime that is not an Apps host
   never issues that read, so the bytes are never produced.
3. ACP has **no frame for a rendered app**. `ToolCallContent` can carry an embedded
   resource, so in principle a runtime _could_ forward one — but nothing asks it to,
   and a design resting on every runtime volunteering an un-asked-for behavior is not
   a design.

So the only viable channel is the one already in place for the daemon's own tools:
**the daemon proxies the UI-capable server and re-exposes its tools through the daemon
bridge.** `mcp/bridge.ts` is a thin `listTools`/`callTool` relay over a UDS to the
running daemon, mounted under the reserved server name. A tool proxied through it is
indistinguishable, from the runtime's side, from a daemon-native one — while the daemon
sits on the call and sees `_meta.ui`.

This also has the precedent it should have. `permissions/memory-write-approval.ts` is
already a **daemon-authored ask** that rides the card machinery so every surface renders
it unchanged; an app card is the same move, with a renderer only one surface has.

```
runtime ──ACP McpServer("agentconnect")──▶ mcp-bridge ──UDS──▶ daemon
                                                                  │  tools/call
                                                                  ▼
                                                         upstream UI-capable
                                                            MCP server
                                                                  │  _meta.ui
                    webchat `app` event ◀── daemon host ◀─────────┘
                              │                    ▲
                              ▼                    │ app_rpc (tools/call, resources/read, …)
                        sandboxed iframe ──────────┘
```

## 4. What is configured

A server definition gains one optional flag (`daemon/src/config/config-schema.ts`):

```jsonc
{
  "mcpServers": {
    "charts": { "transport": "http", "url": "https://mcp.example.test/charts", "ui": true }
  }
}
```

`ui: true` moves the server from **runtime-attached** to **daemon-hosted**. It is
opt-in rather than probed, and deliberately so: hosting a server daemon-side changes
who holds its transport credentials and who its tool calls are attributed to, which is
an operator decision, not an autodetection. `resolveAgentMcpServers` therefore skips a
`ui` server (it must not be handed to the runtime as well, or its tools would be
callable on two paths with only one of them rendering), and the daemon's own
`listTools` merges it in.

Tool names are namespaced `<server>__<tool>` on the bridge, so a UI server cannot
shadow a daemon-native tool, and a name collision between two UI servers is impossible
rather than last-one-wins.

**Daemon-local definitions only, in v1.** `mcpDefsForAgent` overlays CP-pushed
definitions per organization, so hosting one would mean a connection per organization
and a credential boundary between them. Until that exists, a `ui` server must be
configured on the daemon that hosts it; a CP-pushed `ui` flag is simply not read.

Connections are dialed at startup and not waited on. Tool composition is synchronous,
so a session takes the tools of whichever UI servers have connected by then — a server
that is slow or down costs the agent that server's tools, with a warn saying which, and
never delays or fails a session.

## 5. The app card on the wire

One new `WebchatEvent` kind, `app`, beside `elicitation` — and the same
optional-field-over-new-kind discipline the elicitation card records, for the same
reason (a relay or browser predating it drops one frame at most, and a daemon predating
it never sends one).

| field        | meaning                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `appId`      | Unguessable id every RPC from this view carries back. The card's identity, like `requestId`.     |
| `title`      | The tool's own title — the words above the frame, and the words a decline uses.                  |
| `html`       | The `ui://` template's text, capped (§7.4). Inlined rather than linked: the CP stores no bodies. |
| `toolName`   | Which tool opened it, for the card header and the transcript row.                                |
| `toolInput`  | The call's arguments, delivered to the view as `ui/notifications/tool-input`.                    |
| `toolResult` | `{ content?, structuredContent? }` — delivered as `ui/notifications/tool-result`.                |
| `csp`        | The domain allowlists the server declared (`connect`/`resource`/`frame`/`baseUri`).              |
| `dimensions` | `containerDimensions` — fixed, or which axis is flexible.                                        |

`app_resolved` is its settlement, keyed by `appId`: `closed` (the reader dismissed
it), `superseded` (the same tool opened a new one), `expired` (the session ended).
A settled card is rendered inert — the transcript keeps the frame's _header and final
result_, never a live iframe, because a persisted app is a screenshot of a decision, not
a page to re-run against a session that no longer exists (§8).

The browser answers over one new `RelayWebchatOp`, `app_rpc`, carrying the view's
JSON-RPC request verbatim plus `appId`. Only the four host methods that need the daemon
travel: `tools/call`, `resources/read`, `ui/message`, `ui/update-model-context`. The
rest of the spec's surface is browser-local (§7.3).

## 6. The decline, on every other surface

A UI-capable tool called from Slack, Telegram, Discord, Feishu, a hook, a cron turn or
a dream is **not** an error, and the turn is not broken:

1. The tool executes normally against the upstream server.
2. Its text `content` returns to the model unchanged, so the agent can answer in words.
3. The surface gets one **standing notice** — `streamWebchatNotice`'s peer, the same
   `standing: true` line #1794 introduced for exactly this: not a wait, something the
   reader has to keep — naming the tool and saying its interface can only be shown in
   the web console, with the session link.

That is the whole contract. No per-surface reduction ladder, no screenshot rendering, no
"best effort" partial frame. An interface that cannot be shown is declined honestly,
which is the rule the elicitation work already established at field granularity and this
applies at app granularity.

## 7. The sandbox, and where we narrow the spec

### 7.1 Opaque origin, not `allow-same-origin`

SEP-1865 says hosts render with `sandbox="allow-scripts allow-same-origin"`. **We do
not grant `allow-same-origin`**, and this is the one place this design knowingly
diverges.

The spec's assumption is that the host serves app HTML from an origin that is not the
host application's. The console's is: an iframe with `allow-scripts allow-same-origin`
inside `srcdoc` on the console's own origin shares that origin — it can read the
console's `localStorage`, which is where `@logto/browser` keeps the session, and call
the CP's API as the signed-in user. An agent-authored page with the user's console
credentials is not a sandbox.

v1 therefore renders with `sandbox="allow-scripts"` alone: an opaque origin, no
storage, no cookies, no access to console state, `postMessage` still working (that is
what the bridge needs and all it needs). The cost is real and is accepted: an app
cannot persist anything client-side. `ui/update-model-context` is the supported way to
keep something, and it keeps it where it belongs — in the session, on the daemon.

A dedicated app origin (`apps.<console-host>`, or a CP-served sandbox document) is the
principled fix and the follow-up; until it exists, `allow-same-origin` stays off.

### 7.2 CSP

The frame carries a host-built `Content-Security-Policy` meta, restrictive by default:

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'
```

`connectDomains`, `resourceDomains`, `frameDomains` and `baseUriDomains` declared on the
resource widen exactly their own directive and nothing else. Per the spec, the host **may
restrict further and MUST NOT allow an undeclared domain** — so the allowlist is built from
the declaration, never from the page.

### 7.3 Which host methods the daemon serves

| view → host               | served by | note                                                                                      |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `ui/initialize`           | browser   | handshake; the host's reply carries theme + display mode + dimensions                     |
| `ui/notifications/*`      | browser   | size changes, logging                                                                     |
| `ui/open-link`            | browser   | `http`/`https` only, opened in a new tab with `noopener` — same rule the consent card has |
| `tools/call`              | daemon    | forwarded to the upstream server. Only tools of **this app's own server**                 |
| `resources/read`          | daemon    | forwarded; `ui://` and the server's own resources only                                    |
| `ui/message`              | daemon    | injected as an ordinary user turn in the conversation, attributed to the reader           |
| `ui/update-model-context` | daemon    | held on the session, bounded, and prepended to the next turn                              |

The two the daemon forwards are the ones that matter for authorization, and the rule is
the same one the read-port tools already follow: **the candidate set comes from the
trusted session snapshot, never from the payload.** A view may only reach the server
that opened it, and only for a live `appId` in its own conversation.

### 7.4 Bounds

- One template ≤ 96 KiB of HTML, and one whole card ≤ 160 KiB encoded. Both numbers come from
  the wire rather than from taste: the card rides the same `rd/chat` frame every reply chunk
  does, and that frame is capped at 256 KiB (`MAX_FRAME_BYTES`) — with JSON escaping, a
  quote-dense HTML document can approach 2× on the way in. An oversized template is declined
  with a notice, never truncated; an oversized CARD sheds its `toolResult` first (the model
  already received that) and is declined only if it still will not fit.
- At most 4 live app cards per conversation; opening a fifth settles the oldest as
  `superseded`.
- A view's `tools/call` is rate-limited per `appId`, and every call is a real tool call
  in the transcript — an app cannot act invisibly.
- `ui/message` is charged the same hop budget an agent-call activation is, for the reason
  `hopCount` exists: a page that can post into the conversation is a loop source.

## 8. Body-locality

Unchanged, and worth stating because an app looks like content: the CP stores no app
HTML, no `structuredContent`, and no view RPC. The card is streamed relay-to-browser,
persisted in the **daemon's** transcript as an `app` row (header, tool, final result —
not the template), and an authorized BFF history read proxies that row from the owning
daemon like any other. A reloaded conversation shows the settled card, never a re-armed
iframe.

## 9. Plan

| #   | Change                                                                                     |
| --- | ------------------------------------------------------------------------------------------ |
| 1   | `protocol`: `AppCard` + `app` / `app_resolved` events, `app_rpc` op, caps                  |
| 2   | `daemon`: `ui` flag in config schema; `resolveAgentMcpServers` skips a UI server           |
| 3   | `daemon`: `mcp/apps/` host — client, capability negotiation, template cache, tool proxy    |
| 4   | `daemon`: card emission on a `_meta.ui` tool result; the standing-notice decline elsewhere |
| 5   | `daemon`: `app_rpc` handling for the four forwarded methods                                |
| 6   | `web`: `McpAppView` — sandboxed frame, CSP, JSON-RPC bridge, theme + size                  |
| 7   | tests: protocol codec, proxy + emission + decline, bridge RPC authorization, renderer      |

Items 1–6 are v1. A dedicated app origin (§7.1) and `allow-same-origin` are explicitly
follow-ups, as is any second renderer on any other surface — which §2 says will not be
built.
