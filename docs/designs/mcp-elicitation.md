# MCP-Side Elicitation

**Status:** Audit + design record. **The mechanism has shipped; no product call site has.**
[#2016](https://github.com/agentconnect-md/agentconnect/pull/2016) (`ff2fe00d`) landed the ask seam —
`packages/daemon/src/mcp/ask.ts`, the bridge's capability read, the `mcpAsk` IPC result and the
`input_required` return — proven end to end by a test-only tool, with every product tool still
guessing or failing exactly as before. `daemon-detailed-design.md` §9.5 is that seam's summary; this
document is the record behind it. It closes the first checkbox of issue
[#1965](https://github.com/agentconnect-md/agentconnect/issues/1965) (the audit), corrects two claims
in that issue and one of its own, records a live check against the two harnesses this repo pins, and
retires Gap B as a non-goal for the elicitation use case. Every `file:line` citation below was
re-derived by opening the file at this branch's base, `31ad57e3`; nothing is carried over from the
issue text.

**One measured result arrived after #2016 and revises it.** §5.6 shows that an ask the bridge issues
is forwarded by both pinned harnesses onto the ACP wire and rendered by **our own chat cards**, not
only by the agent's host. §9.5's "never a chat surface" is corrected in the same change as this
document.

Prior art: [#1794](https://github.com/agentconnect-md/agentconnect/issues/1794) closed elicitation
on the **ACP** wire, where the daemon is the client and every chat surface renders the ask. The
reduction (`elicitForm`, `ElicitSurface`) and the four per-platform `ElicitCardFacet` implementers
live there. This document is the **MCP** wire, where our protocol role is reversed: the
`agentconnect` bridge is a server.

## 1. Two wires, two roles

| Wire                         | Our role   | Who renders an ask                                   | Owning document                                            |
| ---------------------------- | ---------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| ACP (daemon ↔ agent harness) | client     | our chat surfaces + webchat                          | #1794, [`slack-approval-dm.md`](slack-approval-dm.md) §6.4 |
| MCP (harness ↔ our bridge)   | **server** | **also our chat surfaces** — the harness forwards it | this document, §5.6                                        |

The two roles are reversed, but the **renderer is the same one**. A bridge-issued MCP ask does not
stop at the agent's own host: both pinned harnesses forward any MCP server's elicitation onto the
ACP wire, our bridge included, so it lands back at the daemon that asked it and renders on the same
chat card #1794 built. §5.6 is that measurement, run against a server carrying our own reserved
name. An earlier draft of this document said the opposite; it was wrong.

The bridge is `packages/daemon/src/mcp/bridge.ts` — a stdio MCP server that relays `tools/list` and
`tools/call` to the daemon over a Unix-domain control socket
(`packages/daemon/src/mcp/control-server.ts`), where `executeTool` (`packages/daemon/src/mcp/ops.ts:355`)
does the real work. Two entries reach it: the daemon's hidden `mcp-bridge` subcommand where the
runtime shares the filesystem, and the runtime image's own bundle
(`packages/daemon/src/shim/mcp-bridge.ts`, built by `build:shim`) where it does not.

## 2. Two corrections to issue #1965

### 2.1 A server cannot declare `capabilities.elicitation`

The issue's second checkbox asks us to "declare `capabilities.elicitation` on the bridge server."
**That is not something a server can do.** Elicitation is a _client_ capability. In
`@modelcontextprotocol/server` 2.0.0 (already a dependency; no bump needed):

- `ClientCapabilitiesSchema` carries `elicitation: ElicitationCapabilitySchema.optional()` —
  `dist/src-CX2iR2pK.mjs:794`.
- `ServerCapabilitiesSchema` carries `experimental`, `logging`, `completions`, `prompts`,
  `resources`, `tools`, `tasks`, `extensions` — and **no `elicitation` member** —
  `dist/src-CX2iR2pK.mjs:814-826`.

So `bridge.ts:122-124`'s `{ capabilities: { tools: {} } }` is correct and did not change. What the
bridge does instead is **read the client's declaration** and gate the ask on it — §3.

### 2.2 The lenient capability rule, and why it is load-bearing

The server SDK stores the client's declaration **verbatim** — `dist/mcp-DXXb3Vv3.mjs:1015`,
`this._clientCapabilities = request.params.capabilities` — and applies leniency only at gate time.
The rule is `isImpliedCapabilityMember` (`dist/src-CX2iR2pK.mjs:462-473`), documented in the block
immediately above it: _"a bare `elicitation: {}` declaration (no mode sub-capability at all) is read
as form support — the pre-mode (2025) meaning of a bare declaration … Declaring any mode explicitly
(for example `elicitation: { url: {} }`) removes the implication."_

Restated as the test an implementation must use:

```
form = e != null && (e.form !== undefined || e.url === undefined)
url  = e?.url !== undefined
```

**This is load-bearing, not pedantry.** On the Claude path the embedded `claude-code` MCP client
declares a **bare `{}`**, observed verbatim on the wire:

```
"capabilities":{"roots":{"listChanged":true},"elicitation":{}}
```

(`1965-livecheck/claude-acp/server.A.log` seq 3; `clientInfo` is `claude-code` 2.1.257 inside
`@agentclientprotocol/claude-agent-acp` 0.76.0.) A naive `e.form != null` read would therefore
silently disable **every ask on the Claude runtime** while Codex kept working — a per-runtime defect
no unit test over our own JSON would catch, because the input that breaks it is written by the
harness.

Note the asymmetry, since both rules meet in this seam: our own **ACP** client declaration is read
by codex-acp with a _strict_ test — `clientCapabilities?.elicitation?.form != null`
(codex-acp 1.11.0-agentconnect.1 bundle, `dist/index.js:25898-25902`, applied in
`shouldUseAcpElicitation` at `:26298-26307`) — which our `elicitation: { form: {}, url: {} }`
(`packages/daemon/src/acp/acp-host.ts:878`) satisfies explicitly. Lenient on the MCP-server side,
strict on the ACP-agent side.

## 3. Mechanism: a return value, never an inverted IPC — shipped

`@modelcontextprotocol/server` 2.0.0 exports `inputRequired`, `inputResponse`, `acceptedContent`,
`isInputRequiredResult`, `InputRequiredResult`, `InputResponseView` and
`MissingRequiredClientCapabilityError` (`dist/index.d.mts:738`). A tool **handler returns** "I need
input"; the SDK issues `elicitation/create` and **re-invokes the handler** with the answer. The
serving knobs are `inputRequired: { maxRounds?, roundTimeoutMs?, legacyShim? }` on the server
options (`dist/createMcpHandler-CLhGwQTn.d.mts:2807-2832`), defaults `8`, `600_000`, `true`
(`dist/mcp-DXXb3Vv3.mjs:485`, `DEFAULT_LEGACY_SHIM_ROUND_TIMEOUT_MS = 6e5`, applied at `:492`).

**What #2016 built on it**, in the order a question travels:

| Step                                                                                                                                                                                 | Where                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| The bridge reads the host's declaration **per call** (it exists only after `initialize`) by the SDK's lenient pre-mode rule, and carries it on the `callTool` frame                  | `bridge.ts:133` → `askModes` (`ask.ts:108-115`)                                                |
| `McpControlServer` mints an `AskPort` **only** when that frame declared a form-capable host — the structural guard against an old in-sandbox bridge                                  | `control-server.ts:119`, injected as `deps.ask` at `:126`                                      |
| A tool calls `askHost(deps.ask, key, spec)`: no port ⇒ `unavailable` and its previous behaviour; an answer already present ⇒ `answered`/`refused`; otherwise it throws `AskRequired` | `ask.ts:100-105`                                                                               |
| The control server turns that throw into an `mcpAsk` IPC result; with no port it is a plain tool error instead                                                                       | `control-server.ts:130-137`, `IpcAskRequiredResult` (`ipc.ts:49-57`)                           |
| The bridge turns `mcpAsk` into the SDK's `input_required` return, and the SDK's shim runs the elicitation leg and re-calls the tool                                                  | `bridge.ts:144-148`, knobs pinned at `:124` (`ASK_MAX_ROUNDS` 2, `ASK_ROUND_TIMEOUT_MS` 120 s) |

The reduction to MCP's restricted flat-object schema is `askRequestedSchema` (`ask.ts:92-98`), which
emits **no root key beyond `type`/`properties`/`required`** — §5.3.1 is why — and puts
`title`/`description`/`oneOf` at property level, where a card renders them from anyway.

**No daemon → bridge request direction, and that has not changed.**
`packages/daemon/src/mcp/ipc.ts` has one undiscriminated id space minted only by the bridge
(`bridge.ts:28`, `:64-70`); the bridge silently **drops** an inbound frame whose id is not pending
(`bridge.ts:50-51`); and the daemon answers an unknown token with
`{ id, ok: false, error: 'unknown or expired session token' }` echoing the id
(`control-server.ts:117`), which the bridge's correlator would then match against its own live call
of that id and fail a real tool call with a bogus error. The return-value mechanism needs none of
this: the ask is issued by the bridge process, on the MCP connection it already owns.

## 4. The audit (issue #1965, checkbox 1)

**Every site below is still open.** #2016 shipped the mechanism with no product caller, so each of
these tools guesses, suppresses or fails today exactly as it did before that change.

### 4.1 The issue's three candidates

| Candidate                    | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shareFile` destination      | **REFUTED by construction**             | The tool takes no coordinates at all — `packages/daemon/src/mcp/ops/share-file.ts:13-15`: _"this tool takes NO coordinates at all … no new authorization question exists because the model cannot name a destination."_ The destination is read from the trusted turn at `:119`, `deps.shareTarget?.(ctx)`. It is also a stated user-facing convention — [`product-conventions.md`](../product-conventions.md)`:371-380`, _"every coordinate comes from the trusted active turn."_ There is nothing to ask, and asking would _introduce_ the authorization question the design removed.                                                                                                                                                                                                                         |
| search scope                 | **REFUTED**                             | `searchPublicMessages` has no platform, integration, or channel selector, and its own comment says why — `packages/daemon/src/mcp/ops/platform-actions.ts:104-107`: _"Not because the search is scoped to one conversation … but because none of those selectors would mean anything. The session decides the gateway and the credential, and the provider honours no channel narrowing at all."_ The handler (`:322-345`) resolves the gateway from `ctx.integrationId` and applies **no** channel filter (`:345`, which also records the reverted attempt). `searchMemory` is the same shape: args are `query`/`topK`/`maxBytes` only (`packages/daemon/src/mcp/ops/memory.ts:133-137`) and the scope comes from `recordSurface(ctx, deps)` at `:322`. Neither tool has a scope a model could be asked about. |
| `sendMessage` target channel | **REAL — deferred by product decision** | See §4.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 4.2 The candidates the audit found that the issue missed

Two of these are _fail/suppress_ cases an ask would improve; one is the bridge's only **silent wrong
answer**, which an ask would fix.

| Site                                                                                      | What it does today                                                                                                                                                                          | Shape of the ask                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/daemon/src/mcp/ops/platform-reads.ts:117` (`listKnownUsers`, from `:110`)       | With >1 bot on the platform, returns `{ users: [] }` plus `MULTI_INTEGRATION_NOTE` — a _suppression_, because the daemon's wrapper declines to pick which bot's history to read (see below) | "Which bot?" — a bounded enum of the agent's own integrations on that platform, from the trusted snapshot                                                                     |
| `packages/daemon/src/mcp/ops/platform-reads.ts:142` (`listChannels`, from `:127`)         | The same suppression for the observed-history fallback, reached only after the live gateway call returns `[]` on a platform whose bot API cannot enumerate chats (`:136-138`)               | The same bounded enum — but see the ordering note below: on this path the bot has already been picked                                                                         |
| **`packages/daemon/src/mcp/ops/gateway.ts:52`** (`resolveGatewayForPlatform`, from `:42`) | With no `integrationId` and no match on the session's own integration, **silently picks `candidates[0]`**                                                                                   | The same bounded enum — and this is the highest-value ask in the bridge, because it is the one place a tool returns a confident answer that may simply be about the wrong bot |

**This is a selection gap, not an attribution gap** — and the difference decides whether an ask is
worth building. The store has been scoped per physical bot since
[#224](https://github.com/agentconnect-md/agentconnect/pull/224) ("scope observed chats to physical
bots"): `LocalStore.observedChannels(agentId, platform, transportScope)` and `observedUsers` beside
it both filter `WHERE agentId = ? AND platform = ? AND transportScope = ?`
(`packages/daemon/src/store/local-store.ts:2066` and `:2087`), and `transportScope` is
`` `${platform}:${sha256(platform\0connectionIdentityFor(integration))}` `` (`daemon.ts:15607-15613`) —
one value per physical bot. What refuses is the daemon's wrapper: it computes a scope only when the
agent has exactly one integration on the platform and returns `[]` otherwise
(`daemon.ts:2852-2863`). So a chosen bot _does_ disambiguate the history; nothing has to be
re-attributed first, and the ask needs no storage prerequisite.

**Two comments still assert the older, pooled shape** and will mislead the next reader:
`platform-reads.ts:102-109` ("The local session store is keyed by agent+platform, NOT by
integration") with its ponytail suggesting a new `sessions.integrationId` column, and
`MULTI_INTEGRATION_NOTE` itself ("observed history is not tracked per bot", `gateway.ts:12-15`).
Both describe the pre-#224 shape and are stale, like the `coordinator.ts` comment in §5.1. Flagged, not
fixed here — this is a docs change.

**Ordering note for `listChannels`.** Its suppression sits _after_ `resolveGatewayForPlatform`, so by
the time that branch is reached a bot has already been picked — silently, by `candidates[0]`, if the
session's own integration did not match (`gateway.ts:52`). One ask at gateway resolution therefore
covers both this row and the gateway row itself; a second ask at the fallback would be asking about a
decision already made.

`MULTI_INTEGRATION_NOTE` (`gateway.ts:12-15`) already tells the model to "pass a specific
`integrationId`", which is exactly the information an elicitation would collect from a human instead
of hoping the model guesses. All three asks share one enum — `integrationsOnPlatform(ctx, platform)`
(`gateway.ts:29`) — drawn from the trusted session snapshot and therefore **bounded, small, and
never sourced from tool input**. That is what makes them the right first asks: a closed enum, a
read-only effect, and a tool body that is safe to replay (§7 rule 4).

### 4.3 `sendMessage` target channel: deferred, with reasons

`sendMessage` does not guess a target; it **fails**. With no `toAgent`, `toUser` or `channel` it
throws `` `toAgent`, `toUser`, or `channel` must select the target `` plus `SEND_MESSAGE_TARGET_HELP`
(`packages/daemon/src/mcp/ops/messaging.ts:448-452`), and the `channel` branch requires the id
(`:104`). So an ask is genuinely available here, and the issue was right that it is the highest-value
one in principle.

It is nevertheless **deferred**, for three reasons the next person should not have to re-litigate:

1. **The enum is unbounded.** Unlike §4.2's integration list, the candidate set is every channel the
   bot can see. `listChannels` enumerates it on some platforms and returns `[]` on others
   (Telegram — `platform-reads.ts:136-138`), so the ask degrades to a free-text box on exactly the
   platforms where a mistyped id is least recoverable.
2. **The effect is visible and irreversible.** Every visible `sendMessage` lands at a channel
   **root** ([`product-conventions.md`](../product-conventions.md)`:377-378`) — in front of a whole
   channel. A wrong answer is not a wasted read; it is a post.
3. **It needs a product amendment first.** `product-conventions.md:340` states what `sendMessage` is
   for as a user-facing invariant. Adding "and it may ask you which channel" changes that contract,
   and belongs in that document before it belongs in code.

The §4.2 asks have none of these properties, which is why they are the recommended first
implementation and this one is not.

## 5. The live check

### 5.1 The forwarding chain

A third-party MCP server's elicitation reaches our own daemon. Both harnesses this repo pins forward
it onto the ACP wire, where the code #1794 landed picks it up.

```mermaid
flowchart TD
  S["third-party stdio MCP server<br/>elicitation/create"] --> H["agent harness<br/>claude-agent-acp / codex-acp"]
  H -->|"ACP elicitation/create<br/>sessionId, mode: form"| A["acp-host.ts:818<br/>onRequest(client.elicitation.create)"]
  A -->|"acp-host.ts:835"| D["daemon.ts:5168<br/>onElicit → permissions.onAcpElicit"]
  D --> C["coordinator.ts:1446<br/>onAcpElicit"]
  C --> W["webchat in-stream card<br/>coordinator.ts:1482"]
  C --> P["platform ElicitCardFacet<br/>coordinator.ts:1491"]
  C --> E["Agent-editor queue<br/>console / approval DM"]
```

Our own bridge enters at the same top node, and §5.6 is the measurement that says so.

The gate is exactly the capability `acp-host.ts:878` already declares —
`elicitation: { form: {}, url: {} }`. The frame carries a `sessionId`, **no** `toolCallId` and no
`_meta.codex_approval_kind`, so `isMcpToolApprovalElicitation`
(`packages/daemon/src/daemon/tool-classification.ts:78-80`) is `false` and the `onElicit` branch is
taken: a third-party server's _question_ is cleanly distinguishable from Codex's own _MCP-tool
approval_, which takes the editor queue instead (`coordinator.ts:1462-1469`).

One correction to the code's own commentary while we are here: `coordinator.ts:1440-1445`'s doc
comment says the ask is rendered "as a Slack card." The body no longer does that — it dispatches
through `this.host.elicitCardFacet(p.plan.platform)` (`:1491`), webchat (`:1482-1486`), or the editor
queue, and declines only where the surface has no facet. The comment is stale, not the code.

### 5.2 What was run

Instrument: a throwaway stdio MCP **server** on `@modelcontextprotocol/server` 2.0.0 with one tool,
`ask_a_question`, whose handler returns
`inputRequired({ requestState, inputRequests: { colour: inputRequired.elicit(...) } })` — a titled
single-select enum, Red/Green/Blue — and on re-entry reports the answer.
`inputRequired: { roundTimeoutMs: 20000, maxRounds: 2, legacyShim: true }`, so nothing sat on the
600 s default. Artifacts, including a verbatim tap of every JSON-RPC frame in both directions, are in
the session scratchpad under `1965-livecheck/`.

| Run  | Harness                                         | Variant                                                              | Result                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | claude-agent-acp 0.76.0                         | ACP client declares `elicitation: { form, url }`                     | **Forwarded and answered.** MCP `elicitation/create` out (`claude-acp/server.A.log` seq 14) → ACP frame in (`claude-acp/client.A.log:39`; `VERDICT elicitationReachedAcpClient: true` at `:54`) → accept `{colour:"green"}` → tool returned `ROUND-TRIP OK: a human answered "green".` (seq 19) |
| B    | claude-agent-acp 0.76.0                         | same, the human **declines**                                         | **Forwarded and declined cleanly.** `{"action":"decline"}` re-entered the handler as `{kind:'elicit',action:'decline'}`; the tool returned an `isError` result — a decline needs no exception (`claude-acp/server.B.log` seq 15-19)                                                             |
| 4    | codex-acp 1.11.0-agentconnect.1 / @openai/codex | `CODEX_CONFIG={"features":{"default_mode_request_user_input":true}}` | **Full round trip.** ACP `elicitation/create` with `isCodexOwnApproval:false`, `_meta:null` (`acp-wire.run4.log` seq 16-17) → accept → tool completed → the model echoed `ROUND-TRIP OK` (seq 21-34)                                                                                            |
| 5    | same                                            | `CODEX_CONFIG={}` — feature flag **off**                             | **Still forwarded; full round trip.** See §5.3.3                                                                                                                                                                                                                                                |
| 6    | same                                            | ACP client declares **no** `elicitation` capability                  | **Not forwarded (0 frames).** Codex auto-cancelled; the tool saw `action=cancel` and its tool call went `status:"failed"` (`run6.stdout.txt` seq 17). Graceful degradation, no hang                                                                                                             |
| 1, 7 | same                                            | fixture emits a **root-level `title`** in `requestedSchema`          | **Not forwarded (0 frames).** See §5.3.1                                                                                                                                                                                                                                                        |

Both harness versions are the ones this repo pins: `CLAUDE_ACP_VERSION=0.76.0` and
`CODEX_ACP_VERSION=1.11.0-agentconnect.1`, `docker/runtime-sandbox.Dockerfile:7-8`.

### 5.3 Boundary conditions an implementation must respect

**5.3.1 A root-level `title` in `requestedSchema` kills the codex forward.** Codex core re-parses
`requestedSchema` with a deny-unknown-fields type. Observed: zero forward frames and
`` unknown field `title`, expected one of `$schema`, `type`, `properties`, `required` ``
(`codex-appserver-logs-run7/app-server.log`), with the tool left holding `action=cancel`. An emitted
`requestedSchema` must therefore carry **no root keys beyond `$schema` / `type` / `properties` /
`required`**. Property-level `title` / `description` / `oneOf` are fine and are exactly what the card
renders from. The claude path is more tolerant — the same root `title` survived into its ACP frame
(`claude-acp/client.A.log:39`) — which is precisely why a form that works on one harness proves
nothing about the other.

**5.3.2 Codex's agent-full-access profile cancels a plain question.** In `handleElicitation`
(codex-acp 1.11.0-agentconnect.1 bundle, `dist/index.js:26151-26158`), when
`fullAccessHttpServers?.(params)` returns a set, the ask is accepted **only** if it is a tool
approval (`context.isToolApproval`) with session persistence for a known server; everything else
returns `{ action: 'cancel' }` **without ever reaching ACP**. A third-party server's question is not
a tool approval, so under that profile it is cancelled. **Read from source only — not observed
live** (§5.4).

**5.3.3 Codex's `request_user_input` feature flag is not the gate for an MCP server's ask.**
`packages/daemon/src/runtimes/codex-config.ts:85-87` says the feature is "the only path from a Codex
turn to our ACP form elicitation," and `acp-host.ts:724-725` therefore enables it whenever the host
services session elicitations. That holds for **Codex's own** ask. It does **not** hold for a
third-party MCP server's: run 5 forwarded and completed a full round trip with `CODEX_CONFIG={}`.
The two paths are independent; do not reason about one from the other.

**5.3.4 The negotiated MCP protocol version was `2025-11-25` on both paths**, the era where the SDK's
legacy shim (real server→client requests plus handler re-entry) does the work rather than the client
fulfilling an `input_required` return. One handler serves both eras, but the round-timeout and
max-rounds knobs are the shim's.

### 5.4 What was NOT observed

The check is narrower than "it works". Stated plainly, with the next experiment for each:

| Gap                                               | What is actually known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Next experiment                                                                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No full daemon-to-chat round trip**             | The **ACP frame** was observed arriving at a test ACP client that declares the same capability the daemon declares. The daemon half was read from source (`acp-host.ts:818` → `daemon.ts:5168` → `coordinator.ts:1446`), not executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Run a real daemon with a Slack (or webchat) turn, register the fixture as a session MCP server, and capture the card plus the answer's return path end to end.                                                              |
| **Daemon as both asker and renderer, unproven**   | §5.6 proves the routing; it does not prove the **loop closes**. Every run used a standalone ACP client, so no run had the daemon issuing the ask (blocked bridge tool call) _and_ servicing the same session's `elicitation/create` on a live turn. Nothing structural forbids it — `acp-host.ts:818` is an ordinary concurrent `onRequest`, not serialized behind the in-flight `session/prompt`, and `askMemoryWriteApproval` already blocks a bridge tool call while its turn renders a card — but "no deadlock found by reading" is not a measurement, and #2016's end-to-end test does not supply one: it drives the real bridge from an SDK MCP `Client`, with no harness and no coordinator. | Same experiment as the row above, using #2016's own `test/ask-stub-tool.ts` as the asking tool: assert the card appears, the answer returns, and the replayed call completes rather than hanging to `ASK_ROUND_TIMEOUT_MS`. |
| **§5.3.2 full-access auto-cancel is source-only** | The branch and its condition were read in the shipped bundle. No run exercised a permission-profile / full-access session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Launch codex-acp under a permission profile with an HTTP MCP server configured, issue a non-approval form ask, and confirm 0 ACP frames + `action=cancel`.                                                                  |
| **URL mode unprobed**                             | Every run used `mode: "form"`. The daemon declares `url: {}` (`acp-host.ts:878`), the coordinator has a distinct consent path for it (`coordinator.ts:1481-1491`), and codex gates it on `clientSupportsUrlElicitation` (`dist/index.js:26303-26304`).                                                                                                                                                                                                                                                                                                                                                                                                                                              | Have the fixture issue a URL-mode elicitation; check both harnesses forward it and that the URL never enters model context or a card body.                                                                                  |
| **Timeout/abandonment against a real harness**    | The fixture has a 20 s watchdog and a `--hang` self-test, but no run left a harness ask unanswered to its own deadline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Answer nothing; observe what each harness does at its own timeout and what the tool receives.                                                                                                                               |
| **In-sandbox (image shim) bridge unprobed**       | All runs used a local stdio server. The in-sandbox bridge ships on the _image's_ cadence, not the daemon's (§7 rule 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Repeat run 4 inside a runtime-sandbox pod against the image's own `mcp-bridge.js`.                                                                                                                                          |

### 5.5 Harness coverage

**The separate harness-coverage sweep commissioned for this document returned no report** — its
output directory is empty. This table therefore carries only what the live check itself verified.
Every other row is `UNVERIFIED` and must be treated as unknown, **not** as inferred from a sibling
harness: the two harnesses we did probe already disagree about a root-level `title` (§5.3.1), so
per-harness verification is the only thing that counts here.

| Harness                                                                                                                                      | Version                                                                                       | MCP ask → ACP `elicitation/create`                                                                                                                                                | Evidence                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentclientprotocol/claude-agent-acp`                                                                                                      | 0.76.0 (pinned, `docker/runtime-sandbox.Dockerfile:7`)                                        | **VERIFIED — forwards.** Accept and decline both round-trip; tolerates a root-level `title`                                                                                       | runs A, B (`1965-livecheck/claude-acp/`). Mechanism also read in the 0.75.1 bundle on disk: `dist/acp-agent.js:5348-5352` `handleMcpElicitation` — _"forwarding them to the client over ACP"_ — attached at `:5988` only when the ACP client advertised support |
| `@agentconnect.md/codex-acp` (+ `@openai/codex`)                                                                                             | 1.11.0-agentconnect.1 (pinned, `docker/runtime-sandbox.Dockerfile:8`)                         | **VERIFIED — forwards.** Rejects a root-level `title` before ACP; auto-cancels when the ACP client declares no `elicitation`; unaffected by the `request_user_input` feature flag | runs 1, 4, 5, 6, 7 (`1965-livecheck/acp-wire.run*.log`)                                                                                                                                                                                                         |
| DeepSeek harness (`dsh-acp`)                                                                                                                 | `@openma/deepseek-harness-acp@^0.4`; image pin 0.4.31 (`docker/runtime-sandbox.Dockerfile:9`) | **UNVERIFIED**                                                                                                                                                                    | not probed                                                                                                                                                                                                                                                      |
| `antigravity-acp`, `opencode`, `kilocode`                                                                                                    | present in the local runtime store; no repo pin read for this document                        | **UNVERIFIED**                                                                                                                                                                    | not probed                                                                                                                                                                                                                                                      |
| Curated registry entries (`hermes-agent`, `open-interpreter`, `kiro-cli`, `qoder-cli`, `qoder-cli-cn`) and the public ACP registry generally | see `packages/daemon/src/runtimes/curated.ts`                                                 | **UNVERIFIED**                                                                                                                                                                    | not probed                                                                                                                                                                                                                                                      |

A harness that does not forward is not a correctness problem for us, because both non-forwarding
outcomes we observed are graceful: `action: cancel` or `action: decline`, re-entered into the handler,
with the tool free to return a usable result. Preserving that is §7 rule 6.

### 5.6 Our own bridge is not exempt: a Gap A ask renders on our cards

§5.1-§5.5 measured a _third-party_ server. The question Gap A actually turns on is whether the
`agentconnect` bridge is treated differently — and it is not. **Neither pinned harness filters an
elicitation by which MCP server issued it**, so an ask our bridge returns is forwarded onto ACP like
any other, arrives at the daemon that asked it, and renders on the chat card #1794 built.

**Measured, not inferred.** The §5.2 fixture was re-registered under `agentconnect` —
`RESERVED_MCP_SERVER_NAME` (`packages/protocol/src/frames/agent.ts:127`), the exact name
`buildMcpServers` hands to ACP `session/new` (`packages/daemon/src/mcp/inject.ts:33`) — and driven by
the same ACP clients, which declare what the daemon declares.

| Run | Harness                         | Server name    | Result                                                                                                                                                                                          |
| --- | ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | claude-agent-acp 0.76.0         | `agentconnect` | **Full round trip.** ACP `elicitation/create` reached the client; accept `{colour:"green"}`; the tool — surfaced to the model as `mcp__agentconnect__ask_a_question` — returned `ROUND-TRIP OK` |
| N2  | codex-acp 1.11.0-agentconnect.1 | `agentconnect` | **Full round trip.** One `elicitation/create` out, accept, `outcome: answered` (fixture obeying §5.3.1)                                                                                         |
| N3  | codex-acp 1.11.0-agentconnect.1 | `ac1965`       | Control. With the root-`title` fixture, **not forwarded** — the same §5.3.1 rejection, logged ``unknown field `title` … server_name="ac1965"``                                                  |

N3 is the control that matters: the original name fails on exactly the input the reserved name fails
on, and succeeds on exactly the input it succeeds on. **The variable is the schema, never the name.**
Artifacts, including the verbatim frame taps, are in the session scratchpad under `1965-gapA/`.

**Why, in source.** claude-agent-acp attaches **one** `onElicitation` callback for the whole query
(`dist/acp-agent.js:5988` → `handleMcpElicitation` at `:5352`), covering every entry of `mcpServers`
— ours included — and gates only on mode versus what the ACP client advertised. codex-acp's
`handleElicitation` (`dist/index.js:26151`) reads `params.serverName` only to test membership of the
full-access HTTP set and to mint a standalone tool-call id, never to exclude; its gate is
`shouldUseAcpElicitation` (`:26298-26307`) — mode plus client capability. Neither bundle contains our
server name at all.

**The daemon cannot tell its own ask apart, and must not try.** The forwarded ACP frame carries no
server identity in either direction — observed as `sessionId`, `message`, `mode`, `requestedSchema`,
`_meta: null`, and no `toolCallId`. That is also what keeps `isMcpToolApprovalElicitation`
(`packages/daemon/src/daemon/tool-classification.ts:78-80`) false, so the frame takes `onElicit` →
`onAcpElicit` (`coordinator.ts:1446`) and the ordinary card path, exactly as §5.1 describes.

Two consequences for the call sites §4 leaves open:

- **A §4.2 ask is worth _more_ on a chat turn than §9.5 assumed** — a real card in the conversation,
  not a prompt in a TUI nobody is watching — and correspondingly little on an unattended one: with no
  live turn `onAcpElicit` returns `undefined`, the host declines, and `askHost` hands the tool a
  `refused` it must already handle (§7 rule 6).
- **The shipped route reaches that card the long way round.** Three extra hops and a whole tool replay
  (§7 rule 4) end at a surface the daemon can raise directly — `askMemoryWriteApproval`
  (`coordinator.ts:1517`) is the standing precedent: the daemon's own ask, on the same surfaces,
  blocking a bridge tool call without ever leaving the daemon. Nothing to undo, but §8 records what a
  call site should weigh.

## 6. Gap B, corrected

Issue #1965's Gap B says that when the agent connects to a third-party MCP server and that server
elicits, "it never reaches Slack", and that putting it there "would mean AgentConnect sitting in the
middle as an MCP **client**, which we do not have at all today."

**The premise is false, and §5 is that exact case.** An ordinary third-party stdio MCP server's
elicitation arrived on our ACP seam, gated on the capability we already declare, and routes to the
chat card through the code #1794 landed. The harness is already the MCP client; we are already the
ACP client that renders its forwarded asks.

Therefore:

- **AgentConnect does not need to become an MCP client or proxy for the elicitation use case.** None
  of Gap B's cost — a per-session client, a routing scheme for its tool results and asks, and a fresh
  argument about the "CP is never on the message hot path" invariant — is owed.
- **What remains is per-harness coverage**, which is §5.5, plus the unprobed conditions in §5.4.
- **Any non-elicitation reason to want an MCP client is a separate question.** This check says
  nothing about it.

The related proxy shape is already rejected on its own grounds in
[`centralized-tool-management.md`](centralized-tool-management.md) §5.1 / §10 — rewriting the legacy
SSE `endpoint` event "means parsing MCP and conflicts with the transparent-proxy rule". The
elicitation non-goal is recorded beside it, pointing here.

## 7. Rules the seam respects

These are properties of the surrounding code, not style preferences. Each has already cost someone an
investigation. Rules 1-3 and 5 are **settled by #2016** and recorded here as the reasoning behind what
shipped; rules 4, 6, 7 and 8 still bind every call site the audit found, which is all of them.

1. **Do not spread `SessionContext` per call.** `packages/daemon/src/mcp/ops/memory.ts:184` keys a
   provenance ledger with `new WeakMap<SessionContext, Set<string>>`, and
   `McpControlServer.writtenMemoryTopics(token)` reads it back through the **original** object from
   the sessions map (`control-server.ts:46-48`, populated at `:36`). A `{ ...ctx, elicit }` built per
   call silently orphans that ledger.
2. **`OpsDeps` is declared in `packages/daemon/src/mcp/ops.ts:169`**, not in `ops/context.ts`. A new
   per-call deps member belongs beside `canRun` (`:188`) and `evaluationTool` (`:200`). A change that
   edits only `ops/context.ts` does not typecheck.
3. **A guard against an old bridge must be structural.** The in-sandbox bridge is the runtime
   **image's** own bundle (`packages/daemon/src/shim/mcp-bridge.ts`, built by `build:shim`), so it
   ships on the image's cadence, not the daemon's — **image skew is the normal case**. An old bridge
   receiving an ask marker inside a tool result would `JSON.stringify` it straight to the model
   (`bridge.ts:155`). The guard therefore belongs in one place, not a line each op remembers.
   **#2016 put it in `McpControlServer.handle`:** the `AskPort` is minted only when _this_ frame
   declared a form-capable host (`control-server.ts:119`), and a tool can mint an ask only through
   that port — so an old bridge, which sends no `ask`, can never receive a marker to stringify.
4. **Re-entry replays the whole tool.** The SDK re-invokes the same handler, so `executeTool` runs
   from the top every round: the turn gate (`ops.ts:361`), the evaluation-tool dispatch (`:367-370`),
   the memory access/approval gate it delegates to (`executeRegisteredTool`, `:413-430`) and the tool
   body — including any I/O the tool already
   did before it decided to ask. **Rule: a tool may only ask before it does observable work, or must
   be safe to replay.** The §4.2 asks satisfy this trivially (they ask before any gateway call); a tool
   that has already posted a message does not.
5. **The turn gate races a human-paced ask.** `ops.ts:361` fails closed with
   `this agent turn has been stopped`, so a user can answer and _still_ get that error if the turn was
   cancelled meanwhile. That is the right outcome — the replayed round refuses and posts nothing — but
   it had to be a chosen one, so #2016 pins `roundTimeoutMs` to 120 s and `maxRounds` to 2
   (`bridge.ts:20`, `:23`, applied at `:124`) rather than inheriting the SDK's 600 s default
   (`dist/mcp-DXXb3Vv3.mjs:485`), which would have let the answer arrive at a long-dead turn.
6. **A decline, a cancel and a timeout must each leave the tool with a usable outcome.** Both observed
   non-answers (`decline`, run B; `cancel`, run 6) re-entered the handler as an `InputResponseView` the
   tool read and turned into an ordinary `isError` result — no exception, no hang. An MCP host that
   cannot or will not render an ask must get today's behaviour, which for the §4.2 sites means the
   existing suppression note or the existing first pick, not a failure.
7. **Test placement.** `packages/daemon/test/mcp-bridge-e2e.test.ts` is in `WINDOWS_EXCLUDED`
   (`packages/daemon/vitest.config.ts:32`) and proves nothing there;
   `packages/daemon/test/mcp-control-server.test.ts` is **not** excluded and does run on Windows, so a
   new case in it must be platform-neutral or carry `it.skipIf(process.platform === 'win32')`.
8. **The #1794 lesson still applies:** our tests assert the JSON we build, never the rules the platform
   applies to it. §5.3.1 is that lesson repeating on a new wire, and §5.6 is it a second time — #2016's
   end-to-end test drives the real bridge from an SDK MCP client, which proves the seam but tells you
   nothing about what a harness does with the frame. Every claim about a harness in this document is a
   live check or is marked UNVERIFIED.

## 8. Open questions

- **Should an unattended turn ask at all?** _Who_ renders is no longer open — §5.6 measured it, and
  the answer is our own cards through #1794's facets, not the host's TUI. What remains is the product
  question underneath: `onAcpElicit` declines when no turn is live, so a headless or webhook turn
  falls back to today's suppression note either way, and deciding it should instead wait for a human
  is a product call, not a mechanism one.
- **The shipped route is longer than it looks, and the first call site should know it.** #2016 chose
  the MCP return-value mechanism, and that is settled. What §5.6 adds is where its card comes out:
  through the harness, back over ACP, onto the very surfaces `askMemoryWriteApproval`
  (`coordinator.ts:1517`) already reaches directly from inside the daemon — at the cost of three
  hops, a whole tool replay (§7 rule 4), and a dependence on per-harness forwarding (§5.5) the direct
  path does not have. Nothing to undo; but a call site whose ask _must_ land should weigh the shipped
  route against that one rather than assume they differ in destination.
- **Should a §4.2 bot disambiguation be remembered for the rest of the turn?** The MCP round trip has
  no natural place to cache it, and `executeTool` deliberately re-evaluates its gates per call (rule
  4). A per-turn memo would be new state with its own invalidation story.
- **Does `sendMessage` (§4.3) want an ask at all**, or a different mechanism — a narrowing read the
  model drives, rather than a question aimed at a human?
