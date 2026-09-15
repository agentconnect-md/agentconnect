# Webchat MCP Apps — agent-authored interfaces in the console

Status: v1 implemented. Closes the webchat half of
[#1966](https://github.com/agentconnect-md/agentconnect/issues/1966).

## 1. Summary

The built-in admin resource now has a native Console rendering path, specified in
[webchat-native-integration-ui.md](webchat-native-integration-ui.md). Its trusted
resource resolver bypasses HTML fetching; the iframe rules below remain the
contract for other MCP Apps.

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

`ui: true` moves the server from **runtime-attached** to **daemon-hosted**. It is set
explicitly rather than probed, and the reason is not that detection is impossible — a
daemon could dial a provider once and read `_meta.ui` off its tool list. It is that the
flag decides **who connects**, and connecting is what renames the server's tools to
`<server>__<tool>`. Detection would let an upstream's later change silently re-home a
server and rename its tools underneath an agent whose prompt names them.

Detection still has a place, and it is the natural follow-up: probe at registration,
offer the result as the field's DEFAULT, and keep the stored value authoritative. That
design needs this column either way — it is what stops the decision moving on its own. `resolveAgentMcpServers` therefore skips a
`ui` server (it must not be handed to the runtime as well, or its tools would be
callable on two paths with only one of them rendering), and the daemon's own
`listTools` merges it in.

Tool names are namespaced `<server>__<tool>` on the bridge, so a UI server cannot
shadow a daemon-native tool, and a name collision between two UI servers is impossible
rather than last-one-wins.

**Daemon-local and CP-pushed definitions both.** A CP-managed provider carries the same
flag (`mcp_provider.ui`, projected onto `McpServerSpec.ui`), so an organization can turn
a provider into a rendered one from the console.

The earlier revision of this section claimed CP definitions were withheld partly because
hosting one would move a **credential boundary**. That was wrong and is corrected here: a
CP provider is pushed as a _relay proxy_ def — `url` points at the relay, `headers` carry
a scoped grant key, and the upstream url and upstream secrets never leave the relay. The
daemon already holds that grant key today, because it hands it to the runtime. Hosting the
provider itself exposes nothing new.

What was real is that a CP definition is **org-scoped**, so a connection may not be keyed
by server name alone: two organizations can each have a `charts` pointing at different
proxies under different grants, and one map keyed by name would let one org's connection
answer the other's calls. Connections are therefore keyed by `(orgId, name)`, and every
host method takes the org the call was resolved in — including the view bridge, which
reads it off the card (`LiveApp.orgId`).

Two consequences of the org scope worth stating:

- Definitions arrive with `register/ok`, not at construction, so only daemon-local servers
  can be warmed at startup. `onMcpDefsChanged` warms the rest as they land, keeping the
  dial off the path of the next session's (synchronous) tool composition.
- The relay proxy forwards JSON-RPC **verbatim, with no method allowlist**, so
  `resources/read`, the `initialize` extension negotiation and `_meta.ui` all pass through
  unchanged. Nothing about MCP Apps needed a relay change.

Connections are dialed at startup and not waited on. Tool composition is synchronous,
so a session takes the tools of whichever UI servers have connected by then — a server
that is slow or down costs the agent that server's tools, with a warn saying which, and
never delays or fails a session.

## 5. The app card on the wire

One new `WebchatEvent` kind, `app`, beside `elicitation` — and the same
optional-field-over-new-kind discipline the elicitation card records, for the same
reason (a relay or browser predating it drops one frame at most, and a daemon predating
it never sends one).

| field        | meaning                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`      | Unguessable id every RPC from this view carries back. The card's identity, like `requestId`.                                                                                                            |
| `title`      | The tool's own title — the words above the frame, and the words a decline uses.                                                                                                                         |
| `html`       | The `ui://` template's text, when small enough to ride this frame. Absent ⇒ it arrives as ordered `app_template` chunks and `htmlBytes` says how much to expect. Never linked: the CP stores no bodies. |
| `toolName`   | Which tool opened it, for the card header and the transcript row.                                                                                                                                       |
| `toolInput`  | The call's arguments, delivered to the view as `ui/notifications/tool-input`.                                                                                                                           |
| `toolResult` | `{ content?, structuredContent? }` — delivered as `ui/notifications/tool-result`.                                                                                                                       |
| `csp`        | The domain allowlists the server declared (`connect`/`resource`/`frame`/`baseUri`).                                                                                                                     |
| `dimensions` | `containerDimensions` — fixed, or which axis is flexible.                                                                                                                                               |

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

The frame carries a host-built `Content-Security-Policy` meta **inside the template's `<head>`**,
restrictive by default:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'
```

Where the meta goes is the whole of whether any of this works, and every wrong answer is silent.
Prepending it to the template displaces the doctype (quirks mode) and lands the policy outside
`<head>`, where browsers do not honor `http-equiv` CSP at all. Inserting it at a `<head>` located
by a text scan is worse: that match may sit inside a comment, a quoted attribute or RCDATA, and
the policy is then commented out or inert text — the frame runs with no declared-domain
restriction whatever.

So the document is **parsed, not scanned**. It is about to be parsed by the browser regardless, so
`buildMcpAppDocument` parses it, inserts into the real `<head>`, and emits the doctype
unconditionally; a fragment needs no special case because the parser supplies the elements it
implies. The markup is re-serialized rather than passed through byte for byte, which is the
accepted cost — what comes out is the parser's own normalization of what went in, which is what
the frame would have rendered either way.

`connectDomains`, `resourceDomains`, `frameDomains` and `baseUriDomains` declared on the
resource widen exactly their own directive and nothing else. Per the spec, the host **may
restrict further and MUST NOT allow an undeclared domain** — so the allowlist is built from
the declaration, never from the page.

### 7.3 Which host methods the daemon serves

| view → host               | served by | note                                                                                                                                                                              |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/initialize`           | browser   | handshake; the result carries `protocolVersion`, `hostInfo`, `hostCapabilities` and `hostContext` — all four required, and the SDK's `App.connect()` rejects a result missing any |
| `ui/notifications/*`      | browser   | size changes, logging                                                                                                                                                             |
| `ui/open-link`            | browser   | `http`/`https` only, opened in a new tab with `noopener` — same rule the consent card has                                                                                         |
| `tools/call`              | daemon    | forwarded to the upstream server. Only tools of **this app's own server**                                                                                                         |
| `resources/read`          | daemon    | forwarded; `ui://` and the server's own resources only                                                                                                                            |
| `ui/message`              | daemon    | injected as an ordinary user turn in the conversation, attributed to the reader                                                                                                   |
| `ui/update-model-context` | daemon    | held on the session, bounded, and prepended to the next turn                                                                                                                      |

The two the daemon forwards are the ones that matter for authorization, and the rule is
the same one the read-port tools already follow: **the candidate set comes from the
trusted session snapshot, never from the payload.** A view may only reach the server
that opened it, and only for a live `appId` in its own conversation.

**A tool name never selects a server.** The server is `app.server`, from the card; the name is
resolved against _that_ server's tool list. This matters in both directions. A view calls its
tool by the name its own server gave it (`refresh`) and has no business knowing that an
operator configured that server as `charts`, so the bridge's `charts__refresh` namespace is
translated at this boundary — and because the server is never derived from the name, a name
like `secrets__read` is simply looked up on this card's server, not found, and refused. A
lexical prefix check could do neither job: it would reject every ordinary app's buttons, and it
could not tell a genuine upstream name containing `__` from an attempt at another server's
namespace.

**A view's `tools/call` gets the RAW upstream result**, structured content included. The
model-facing shaping drops `structuredContent`, which is precisely what a refresh or pagination
tool answers with — hand the model's half back and the interface has nothing to render.

**Both payload shapes are the spec's, not strings.** `ui/message` sends
`{ role: "user", content: ContentBlock[] }`, and `ui/update-model-context` sends `content`
and/or `structuredContent`. The host decodes `text` blocks and serializes the structured half,
which is exactly what its `hostCapabilities` declares — claiming image support would drop an
app's image silently instead of visibly.

**A card's events outlive its turn.** The frame is still on screen and its bridge still served
after the opening turn ends, so the daemon keeps sending replies and settlements on that card's
original `turnId` — while the browser's ordered turn cursor is retired at `done` and its lane
refuses to reopen. `app_rpc_result` and `app_resolved` are therefore applied out of band **when,
and only when, there is no ordered lane to carry them**: an RPC result is correlated by its own
`callId` and a settlement is idempotent on `appId`, so neither needs ordering to be correct.
Without that fallback, a button pressed after the agent finished would hang to its timeout and a
closed card would render as live forever.

The "only when" is the load-bearing half. While the lane is live these events go through the
ordered path like every other frame, because applying one out of band would consume its `index`
without telling the cursor — which then waits for that index forever, leaving the following
reply text and `done` buffered behind it and the conversation wedged as busy. Out of band is
correct only once there is no band.

### 7.4 Bounds

- One template ≤ 1 MiB of HTML, and one whole card ≤ 160 KiB encoded. These bound different
  things on purpose. The CARD rides one `rd/chat` frame, capped at 256 KiB
  (`MAX_FRAME_BYTES`), so it sheds its `toolResult` first (the model already received that) and
  is declined only if it still will not fit. The TEMPLATE does not ride that frame at all past
  48 KiB: a genuine app — one that inlines the official SDK — is several hundred KiB on its own,
  so it arrives as ordered `app_template` chunks of 48 KiB and is reassembled by the browser,
  which is why its cap can describe what a page may reasonably be rather than what one frame
  happens to hold. A template past the cap is declined with a notice, never truncated.
- A template still arriving is not a page. The card declares `htmlBytes`, and the frame is armed
  only once that much has been reassembled — handing an iframe half a document renders a broken
  page, which is the outcome the cap exists to avoid in the first place.
- At most 4 live app cards per conversation; opening a fifth settles the oldest as
  `superseded`.
- A view's `tools/call` is rate-limited per `appId`, and every call is a real tool call
  in the transcript — an app cannot act invisibly.
- `ui/message` is delivered through the ORDINARY user-turn dispatch, under the author the
  relay verified — so the roster check, the busy/steer decision and the transcript apply to it
  exactly as they do to something typed in the composer. It is not hop-charged, because it is
  not an agent post: what bounds a page that posts in a loop is the per-card call budget above
  plus the turn's own busy gate, and a frame is settled the moment its conversation closes.

## 8. Body-locality

Unchanged, and worth stating because an app looks like content: the CP stores no app
HTML, no `structuredContent`, and no view RPC. The card is streamed relay-to-browser and
persisted in the **daemon's** transcript as an `app` row — header, tool, arguments, final result,
the settlement **and the template** — which an authorized BFF read proxies from the owning daemon
like any other body. A reloaded conversation shows the PAGE again, not a note saying one was shown.

The row is written at open and rewritten at settlement (`LocalStore.upsertApp`, the peer of
`upsertElicit`), keyed by the card's own `appId` — the one name a reloaded view knows itself by.

Keeping the template is what makes a reload show the interface, and it is also what would put a
several-hundred-KiB document into every transcript read, so the two are separated rather than
traded: the history projection sheds an oversized row down to a preview and marks it truncated, and
the console pulls the whole card back through the same on-demand `session/tool-body` read an
oversized tool body uses (keyed by the row's `app:<appId>`). One card, one row, one fetch — and a
transcript page that is the size it always was.

The shed is ordered and has a floor. Dropping the template is usually enough; a tool that answered
with tens of KiB of `structuredContent` leaves a card still over the cap with its page already
gone, so `toolResult` goes next and `toolInput` after it. What never goes is the card's IDENTITY —
`appId`, `title`, `toolName`, `outcome` — because a row the console cannot read AS A CARD renders
as a line of text, which is the card vanishing, which is the failure this whole section exists to
prevent. The console then REPLACES the preview with the fetched card rather than lending it a
template: a card that shed its result as well as its page would otherwise arm a frame and hand it
no `tool-result` to render.

### 8.1 Re-arming a reloaded card

A page that renders and cannot act is worse than no page, so a card the registry no longer holds
is rebuilt from its row on the first view RPC that names it (`reviveAppRow`): the reader reloaded,
or the daemon restarted, and the frame in front of them is the one the row records.

Nothing about the rebuild is taken from the frame. The row carries the card's `server` and the
`conversationId` it was opened in; the routed frame supplies only its `appId`, and its own
conversation is re-checked against the row's before anything is revived. A row with no recorded
server — one written before templates were kept — stays a record and is never re-armed, because
refusing to guess at a card's reach is the same rule §7.3 states for a live one. A revived card
re-enters the registry under the ordinary per-conversation cap and its row stops naming an
outcome, since it is live again.

Two settlements are not the same after a reload. `superseded` and `expired` end an _arming_, so
the page still renders and the header says how the last one ended; `closed` is the READER
dismissing the card, and putting that page back on the next paint would undo what they did.

A dismissal is enforced in the DAEMON, not only in the console: `reviveAppRow` refuses a row whose
outcome is `closed`. The console is not the only thing that can revive a card — an RPC already in
flight when the frame closed, or one from a second tab that still had it armed, would otherwise
clear the outcome from the row and hand the page back on the next reload.

A card in a RUNNING turn now exists twice over: as its row, written at open, and as the streamed
`app` event. The console keeps the live copy and steps the row aside (`liveAppKeys`, the peer of
`liveElicitKeys`) — it is the one the registry is serving and the one a settlement reaches.
Without that, a second tab on a running conversation renders one card as two armed frames.

That makes the live copy responsible for the page, so an `app_resolved` no longer drops its
template: a `superseded` or `expired` card would otherwise blank in place, with the persisted row
that still holds the template standing aside for it. A reader-`closed` card hides its page either
way, so that one is still dropped.

The verdict for every view RPC goes back on **the connection the RPC arrived on**, not on the
stream the card was opened on. A card outlives its turn, and after a reload that turn's stream
reaches a browser that is gone — which is a button that hangs rather than one that is refused. The
console already accepts `app_rpc_result` and `app_resolved` out of band for exactly this reason.

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
