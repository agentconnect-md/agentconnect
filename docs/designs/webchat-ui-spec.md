# Agent-authored UI Cards in Webchat

**Status:** Proposal.

A webchat agent can show a small native card (a status summary, a comparison table, a
set of choices) by calling one daemon-local tool, `showUi`, with a declarative spec. The
spec names only components from a fixed catalog that the protocol defines in zod. The
catalog matches the standard chat-card components of `@json-render/chat`, so the same
spec can later render on other chat platforms (§10). The Console renders it with
[json-render](https://github.com/vercel-labs/json-render) mapped onto its own components.
The model never supplies HTML, script, or styles, and a spec that fails validation is
refused before anything is shown.

The card reuses the native-card path built for
[native integration configuration](webchat-native-integration-ui.md): the same
`McpAppCard` frame with a `nativeUi` intent and the same transcript row. A button press
reaches the agent as a user turn that names the card and button it came from. The card is
not an MCP App: no iframe, no bridge, and it does not occupy one of the conversation's live
app slots.

## 1. Decision and user experience

- **Where.** Webchat only in v1, and only in a conversation whose replies stay in the
  Console. A console continuation of a Slack, Telegram, Discord or Lark session is
  excluded, because its reply is also delivered to a platform that cannot show the card
  yet. A webchat turn whose client is not the Console is excluded too: the agent chat API
  (`/ai-sdk`, `/ag-ui`) and AHP clients such as the VS Code extension share the webchat
  turn context and relay bridge but have no renderer (§4, §10). Rendering is a property of
  the reading client, not of the conversation.
- **What the reader sees.** A card in the agent's reply, between the text the agent wrote
  before and after the call. The card keeps the Console's typography, colors, dark mode and
  mobile layout because every component is a Console component.
- **What the agent learns.** The tool's result says whether the card was shown. A refusal
  names the reason (the surface cannot show cards, or the spec is invalid and why), so
  the agent either corrects the spec or answers in Markdown. The agent never assumes a
  card was seen when it was not.
- **Interaction.** v1 has one action. Pressing a button starts the agent's next turn with
  the button's text, marked in the transcript and in the agent's input as a press on that
  card (§6). A link button opens a URL. History views render the same card read-only.
- **When not to use it.** Ordinary answers stay Markdown. The tool description says a card is
  for structured results the reader scans, with optional suggested follow-ups, not for
  prose.
- **Not a question.** A card never blocks the turn and stays pressable later, so it is not
  a way to ask. When the agent needs an answer before it can continue, it uses
  elicitation, which parks the turn and has one settle path. The tool guide states this
  rule.

## 2. Existing foundations

| Foundation                                                                         | Reused for                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NativeMcpUi` in `protocol/src/mcp-app.ts`                                         | The intent union. The UI spec becomes one more member, keyed by its `resourceUri`.                          |
| `McpAppCard` frame (`kind: 'app'`) in `protocol/src/frames/webchat.ts`             | Carrying the card to the browser. Its `nativeUi` field already accepts any member of the union.             |
| `appSurface.open` and `writeAppRow` in the daemon                                  | Posting the card on the turn's stream and persisting it as a transcript row, exactly as a native form does. |
| `McpAppCard` / `NativeIntegrationAppCard` in the web console                       | Dispatching on `nativeUi.resourceUri` and rendering the card chrome.                                        |
| Fill-card answers (`pgAnswerFill`) in `SessionDetailView`                          | Sending a press as a structured event on the composer's live socket, never through a card bridge.           |
| `apiProtocol` on the webchat turn (`ChatTurnContext`)                              | Telling a Console reader from an agent chat API or AHP client.                                              |
| `MarkdownText` in the web console                                                  | Rendering `Text` content with the existing Markdown pipeline and link policy.                               |
| Relay feature advertisement (`webchat-images-v1` → `advertisesWebchatImages`)      | Offering the tool only when the relay and its Console can render the new intent.                            |
| Static-descriptor, dynamic-authority tools (`consoleImages` gating of `shareFile`) | Listing the tool once per session and deciding at execution time whether this turn can show a card.         |

What is missing is the catalog, the tool, the daemon's direct card opening, and the
web renderer.

## 3. The spec and its catalog

A new protocol module, `protocol/src/ui-spec.ts`, is exported as
`@agentconnect.md/protocol/ui-spec`. It defines the catalog in plain zod and does not
depend on json-render, so the wire package and the daemon take no new dependency. The
web console builds its json-render catalog from these schemas (§5), so the daemon
validates and the Console renders against one definition.

### Spec shape

The spec uses json-render's flat element map, so a later version can adopt its state,
visibility and form features without changing the format:

```json
{
  "title": "Deploy status",
  "spec": {
    "root": "card",
    "elements": {
      "card": {
        "type": "Card",
        "props": { "title": "staging", "subtitle": "Deploy status" },
        "children": ["fields", "actions"]
      },
      "fields": { "type": "Fields", "props": {}, "children": ["pods", "latency"] },
      "pods": { "type": "Field", "props": { "label": "Healthy pods", "value": "12 / 12" }, "children": [] },
      "latency": { "type": "Field", "props": { "label": "p95 latency", "value": "184 ms" }, "children": [] },
      "actions": { "type": "Actions", "props": {}, "children": ["promote", "logs"] },
      "promote": {
        "type": "Button",
        "props": {
          "id": "promote",
          "label": "Promote to production",
          "style": "primary",
          "value": "Promote staging to production"
        },
        "children": []
      },
      "logs": {
        "type": "LinkButton",
        "props": { "label": "Open logs", "url": "https://console.example.test/logs" },
        "children": []
      }
    }
  }
}
```

`UiSpecIntent` is `{ title?: string, spec: UiSpec }`. Its `NativeMcpUi` member is built
with the same `nativeApp` helper as the existing members, so it carries
`resourceUri: 'ui://agentconnect/ui-spec'`, `resourceVersion: 1`, `orgId` (filled by the
daemon from the agent's organization, never by the model) and `intent: UiSpecIntent`.
`nativeUiTitle` returns the intent's `title`, or `Card` when it has none.

### v1 catalog

The catalog uses the component names and props of `@json-render/chat`'s
`standardComponentDefinitions`. That set was chosen because every common chat-card format
can express it: Block Kit, Adaptive Cards, Discord components, Google Chat cards, and
Lark cards. Aligning now means a spec the agent learns to write in webchat is the
spec a platform renderer receives later (§10). The protocol redefines these schemas in
zod and does not import the package (§12).

Each component's props schema is `.strict()`. Each schema carries a `.describe()` text,
which becomes the tool's input documentation (§4).

| Component    | Props                                                                      | Children                       |
| ------------ | -------------------------------------------------------------------------- | ------------------------------ |
| `Card`       | `title?`, `subtitle?`                                                      | any except `Card`; root only   |
| `Section`    | none                                                                       | any except `Card` or `Section` |
| `Text`       | `content` (Markdown), `style?: 'plain' \| 'bold' \| 'muted'`               | none                           |
| `Fields`     | none                                                                       | `Field` only                   |
| `Field`      | `label`, `value: string \| number`                                         | none                           |
| `Table`      | `headers: string[]`, `rows: string[][]`, `align?` (per column), `caption?` | none                           |
| `Divider`    | none                                                                       | none                           |
| `Actions`    | none                                                                       | `Button`, `LinkButton` only    |
| `Button`     | `id`, `label`, `style?: 'primary' \| 'danger' \| 'default'`, `value?`      | none                           |
| `LinkButton` | `label`, `url`                                                             | none                           |

- **Text** is Markdown, matching `@json-render/chat`, because every chat platform renders
  some Markdown dialect. The Console renders it with `MarkdownText`, which skips raw HTML
  and applies the agent-Markdown link policy.
- **Button.** `id` is unique within the spec. A press names the card and the button `id`,
  and the daemon derives the text, `value` or `label` when `value` is absent, from its
  stored spec instead of trusting the client (§6). Platform clicks later use the same
  shape (§10).
- **LinkButton** and Markdown links accept only `https:`, `http:` and `mailto:`, and they
  open in a new, opener-isolated tab.
- **Not in v1:** `Image` and `Chart`. An `Image` would make the reader's browser fetch an
  arbitrary agent-chosen host, which leaks the reader's address and is constrained by the
  Console's content security policy, so it needs its own decision. `Chart` waits for a
  chart library the Console adopts for other reasons. A nested `Card`, which
  `@json-render/chat` flattens into a section, is rejected instead of being rewritten.

### Structural rules

`UiSpec` adds a `superRefine` over the element map:

- `root` names an existing `Card`, and every child id resolves.
- The graph is a tree. No element has two parents, there is no cycle, and every element is
  reachable from `root`.
- Each element's children obey the "Children" column above.
- At most 200 elements and a depth of at most 6.
- Each string prop is at most 2,000 characters. A `Table` has at most 12 columns and
  50 rows, a `Fields` has at most 20 fields, and an `Actions` has at most 5 buttons, which is
  the smallest row any supported platform allows.
- The encoded intent is at most 32 KiB, well under `MCP_APP_CARD_MAX_BYTES`, so a valid
  spec always fits its frame and its transcript row.

### What v1 excludes

json-render's dynamic features are rejected by the strict schemas, not just ignored:
`repeat`, `$state`, `$bindState`, `$cond`, `$template`, `$computed`, `visible`, and
`watch`. A spec using them fails validation, and the agent is told which path failed.

## 4. The `showUi` tool

`showUi` is a daemon-local tool on the reserved `agentconnect` MCP server. Its input is
`UiSpecIntent`, validated in full at execution.

The descriptor stays small: a one-paragraph description and an input schema that only
requires `spec` to be an object with `root` and `elements`. The catalog, generated with
`z.toJSONSchema` as the daemon already does for `MessageAttachment`, the example above,
and the "when not to use it" and "not a question" rules live in a `getToolGuide` entry.
The description tells the agent to read that entry first, as `sendMessage` does. This
keeps the catalog out of every session's tool list, including the Slack or Telegram
sessions that are offered the tool only because a console turn might reach them.

### Offer gate

The descriptor is static per session, following the `consoleImages` pattern. A console
turn may reach a session that was not born in webchat, so the session's own platform
cannot decide this. The daemon lists `showUi` when the relay connection advertises
`webchat-ui-spec-v1` (§9). Otherwise the tool does not exist for the agent. The feature
only says the relay's own Console can render the card, so the execution checks below
still decide whether this turn's reader is that Console.

### Execution

The daemon runs the tool itself, so it opens the card directly instead of waiting to
observe the tool result in the ACP stream:

1. Resolve the current turn for the calling session (`appTurnFor` / the pending turn by
   session key). Refuse with the reason "This conversation cannot show cards; answer in
   Markdown." when any of these holds:
   - there is no turn, or the turn is not webchat;
   - the turn is a console continuation;
   - the turn carries an `apiProtocol` (an agent chat API protocol, `ahp`, or any other), so its
     client is not the Console;
   - output is suppressed.
2. Parse the arguments with `UiSpecIntent`. On failure, return the zod issues as a tool
   error with their paths, so the agent can repair the spec in its next call.
3. Open the card through the code path `projectNativeIntegration` uses today, extracted into
   one helper. The helper allocates the `appId`, calls `appSurface.open`, and calls
   `writeAppRow` with `server: ''`, the intent, and the chrome from `nativeUiChrome`
   (`toolFor` gains `UI_SPEC_URI → 'showUi'`). If `appSurface.open` reports the card was
   not shown, refuse with that reason.
4. Return a short receipt such as `{ shown: true, appId }`. The receipt does not repeat the
   spec, which keeps model context small. It also does not parse as an intent, so the
   ACP-stream projection never opens the same card a second time.

### Not a dialog invitation

Today a present `nativeUi` means "a Console dialog invitation", and several readers act on
that. The UI spec member is excluded from each of them by its `resourceUri`:

- **`LiveAppRegistry`.** The card is not registered as a `native` live app. It has no RPC
  bridge to authorize and does not count against `MCP_APP_LIVE_CAP`, so it never
  supersedes an MCP App or a native form, and those never supersede it. Session expiry
  and conversation close have nothing to settle for it.
- **`reviveAppRow`.** A native row with no outcome is revivable. A UI spec row is never
  revived, because there is nothing to re-arm.
- **The Console's native-card handling.** `McpAppCard` checks for the UI spec member before
  its `nativeUi` → `NativeIntegrationAppCard` branch, so the card never registers a
  pending action, never appears in the pending-actions banner, and never shows the
  Waiting or Done state of a native form.

## 5. Rendering in the Console

The web package pins `@json-render/core` and `@json-render/react` to an exact version
(0.23.1 at the time of writing). It does not use `@json-render/shadcn`, because the
Console has its own component set and styling rules (`packages/web/STYLE.md`).

- `components/console/ui-spec/catalog.ts` wraps the protocol schemas with json-render's
  `defineCatalog`.
- `components/console/ui-spec/registry.tsx` calls `defineRegistry` and maps each
  component to Console primitives, styled with Tailwind utilities over the design tokens.
- `components/console/ui-spec/UiSpecCard.tsx` re-validates the intent with `UiSpecIntent`
  before rendering. A spec that fails, for example a row written by a newer daemon, renders
  a short "This card cannot be displayed" notice instead of a partial tree.
- `McpAppCard` dispatches on `resourceUri === UI_SPEC_URI` to `UiSpecCard`. That module is
  loaded with `next/dynamic`, so json-render is fetched only when a card is on the page.

The card renders one responsive tree. `Fields` lays out in two columns at the `desktop:`
breakpoint and one column below it, `Actions` wraps, and `Table` scrolls horizontally
inside the card instead of widening the page.

## 6. The reply action

`UiSpecCard` mounts json-render's `ActionProvider` with exactly one handler, `reply`.
The button text is agent-authored, so a press must not reach the transcript as words the
reader typed. A press therefore carries provenance, not text:

1. The Console sends `{ agentId, appId, buttonId, pressId }` as a structured event on the
   composer's live socket, as Fill-card answers already do (`pgAnswerFill`, which also
   names the card's agent). `agentId` selects the agent whose stored row holds the card in
   a multi-agent conversation. The client supplies `agentId`, so the relay checks it against
   the conversation's roster before forwarding, and the daemon's refusal in step 2 is the
   second check. `pressId` is generated once per press by the Console. The event never goes
   through a card bridge, and the browser does not send the button's text.
2. The daemon loads that agent's stored row for the card in that conversation, checks that the button
   exists, and derives the text: `value`, or `label` when `value` is absent. An unknown
   card or button is refused, and nothing is sent.
3. The daemon starts the reader's turn with that text and records the press provenance on
   the user turn. The transcript renders it as a press, for example "Pressed _Promote to
   production_" with the derived text shown beneath. The agent's input marks it the same
   way, so neither the reader nor the agent can mistake a press for typed words.

A platform click later carries the same provenance, card and button, with the agent
implied by the integration it arrives through (§10), so the Console and chat platforms
share one press path.

- **Admission.** The press event is part of `webchat-ui-spec-v1`, so a relay or daemon
  without the feature never carries it. The derived turn passes the same admission as a
  composer message: it carries the relay-stamped author, it queues behind a running turn,
  and it lands in the card's own thread.
- **Retry.** The press is asynchronous, so the card disables its buttons only once the
  daemon accepts the press. Acceptance means the derived turn was admitted, including into
  the queue behind a running turn, so a queued press counts as accepted. A refused press
  leaves the buttons enabled and shows why, so the reader can retry. The daemon also uses
  `pressId` as the turn's idempotency key, so a retry after a lost acknowledgement never
  starts a second turn.
- After an accepted press, the card shows which button was pressed. It
  remembers this in `localStorage` keyed by `appId`, as `NativeIntegrationAppCard`
  does, so a second tab also shows the card as answered. This is presentational only.
- Where the view has no live socket (history views, non-live sessions, shared read-only
  views), buttons render disabled. Link buttons stay usable.

## 7. Security model

- **No executable content.** The model chooses components and props from a closed catalog.
  It cannot supply HTML, script, CSS, class names, or component types. json-render renders
  through the registry, and `Text` goes through the same Markdown pipeline as agent
  replies, which skips raw HTML.
- **Validation on both sides.** The daemon refuses an invalid spec before the reader sees
  anything. The Console validates again because the transcript row is persisted data.
- **Links.** URLs are limited to web and mail schemes and open in a new tab with
  `rel="noopener noreferrer"`. No image or other resource is fetched from an agent-chosen
  host.
- **Actions.** The only action starts a turn with text the daemon derives from its own
  stored spec, marked as a press on a named card. A prompt-injected agent can still author
  a button's `value`, but the result reads as "the reader pressed this button", not as
  the reader's own words, in both the transcript and the agent's input. A button cannot
  call a tool, read a resource, or act with any authority the reader's own message would
  not have.
- **Size.** The structural limits in §3 bound both rendering cost and row size.

## 8. Data plane and persistence

The spec travels the same way a native form's intent does: from the daemon, on the
webchat stream through the relay, to the browser, and into the daemon's transcript store
as an app row. The Control Plane neither receives nor stores it. Authorized transcript
reads proxy it like any other row. This keeps the invariant that agent output stays on
the data plane.

## 9. Compatibility and rollout

The relay and the browser decode the `app` frame against `McpAppCard`. A relay or Console
that predates the new `NativeMcpUi` member rejects the whole frame, so the reader sees
nothing while the agent believes it showed a card. The rollout therefore uses an explicit
feature:

- `protocol` adds `WEBCHAT_UI_SPEC_FEATURE = 'webchat-ui-spec-v1'`, re-exported for the
  relay–daemon handshake like `RD_WEBCHAT_IMAGES_V1`.
- The relay advertises it for its own Console, which ships with it.
- The daemon offers `showUi` only while the relay connection advertises it (§4). A daemon
  that is newer than its relay never offers the tool. A relay that is newer than its
  daemon advertises a feature that no tool uses.

Two cases remain that the feature cannot close:

- **A Console tab loaded before an upgrade.** The relay advertises the feature, but the
  old tab drops the frame while the agent holds `shown: true`. Earlier native members had
  the tool's own text as a fallback; this one does not. Reloading renders the card from the
  transcript row. This is accepted for v1 because the window lasts only until the tab
  reloads.
- **A Console downgraded below the feature.** The older Console does not know the member,
  fails to parse `nativeUi`, and shows the row as an unarmed app card. The "cannot be
  displayed" notice in §5 applies only to a Console that knows the member but not the
  spec's exact shape, such as a row written by a newer daemon.

## 10. Other chat platforms

v1 renders only in the Console. This section records how the same spec reaches other
chat platforms later, and why the existing system cards do not move to json-render.

### The existing card architecture

The daemon's chat cards follow the
[integration plugin architecture](integration-plugin-architecture.md): core owns
semantic card models, and each platform module renders them and decodes their clicks.

- Core defines what a card means: a permission request (`ApprovalCardAsk`), an
  elicitation, a capability request, a Fill card, and a draft. Each model includes how
  the card reads once it settles.
- Each platform implements optional facets on its `TurnOutputSurface` (`approvalCards`,
  `elicitCards`, `capabilityCards`, `fillCards`). A missing facet means core falls back to a
  notice or the Console.
- A click is forwarded by the relay as a `platform_action`. The owning daemon's
  `RelayCardClicks.decode` turns it into a `ChatCardAnswer`, and core re-derives the
  answer from the card's own parameters instead of trusting the click payload.

At the time of writing, these renderers are about 5,000 lines across ten platforms, with
about 8,600 lines of tests. Most of that code handles platform limits, not layout.
Telegram's `callback_data` holds at most 64 bytes and the platform has no multi-select,
so its elicitation card is a multi-level keyboard of tokens. Discord allows five buttons
per row and five rows per message, and it collects form input through a modal with its own
caps. Lark cards need self-imposed option and label caps and callbacks that identify
their card. Every platform also rewrites a settled card in place, shows some refusals
only to the clicker, and keeps a plain-text fallback for notifications.

### Why system cards stay as they are

Moving system cards to json-render specs would put a generic layer between the semantic
model and the platform renderer without removing any platform code. The limits above
cannot be expressed in a generic spec. A renderer would either infer "this is an approval
card" from the spec, or the spec would grow platform-specific extensions. Elicitation
forms also need inputs, and `@json-render/chat` cards have none. The rewrite would touch
the permission-approval path, which is security-sensitive, in exchange for format
uniformity only. System cards therefore keep their semantic models and facets.

### The incremental route for UI spec cards

Agent-authored cards are new, are display-first, and have one action, so they are the
part that can share one format across platforms:

1. **v1 (this document).** Webchat only, with the catalog aligned to
   `@json-render/chat` (§3).
2. **Later.** The daemon platform contract gains one optional member,
   `uiCards?: UiCardFacet`, which renders a `UiSpec` into the platform's card format and
   rewrites it after a press. `ChatCardAnswer` gains `{ kind: 'reply'; appId; buttonId }`.
   The click names the button, and the daemon recovers the text from its stored spec. That
   fits a 64-byte `callback_data` and keeps answers derived from the card, not from the
   click.
3. **Per platform.** Each platform adds its facet and its registry line, for example
   Slack and Lark first. The offer gate becomes "the current surface has `uiCards`".
   Platforms without the facet are never offered `showUi`, and the agent answers in
   Markdown there.

Each renderer is expected to be comparable to an existing capability card, about 100 to
200 lines, because the catalog is display components plus one button action. No core
`switch` learns a platform name.

The facet is added only when a second surface implements it, following the rule that a
seam member is extracted with its second implementer.

### API and AHP clients

The agent chat API and AHP clients are refused in v1 (§4). A client joins by declaring
that it renders UI spec cards, for example as a capability in its protocol handshake. The
execution check then becomes "the reading client declares UI spec rendering", with the
Console's declaration implied by the relay feature. For the AI SDK protocol, a natural
carrier is a data part holding the intent. For AHP, it is the existing apps projection. Each
of these is decided in its client's own design.

### Relation to sticky choice cards

The open
[sticky choice cards proposal](https://github.com/agentconnect-md/agentconnect/issues/3583)
covers cards that a local service creates and reads, with their own state. UI spec cards
are agent-authored and display-first, and a press is only a turn. `uiCards` does not
replace that proposal. If both land, a platform renderer may share its button and layout
code between them.

## 11. Alternatives considered

- **`@json-render/chat` with the Chat SDK.** `@json-render/chat` converts a spec into the
  Chat SDK's `CardElement`, and the Chat SDK's adapters convert that into each platform's
  format and route clicks to `onAction` handlers. The Chat SDK is a complete bot runtime that
  owns webhooks, connections, state, and event routing in one process. AgentConnect splits
  those duties between the relay, which verifies and forwards callbacks without
  persisting content, and the daemon, which owns connections, rendering, and click
  decoding. Adopting it would add a second platform layer beside the platform modules,
  bypass the click re-derivation in §10, and still leave Lark, DingTalk, WeCom, WeChat and QQ
  without adapters. Only the catalog is adopted (§3).
- **Migrating system cards to json-render.** Rejected in §10.
- **A fenced `json-render` block inside Markdown.** This requires web changes only. However,
  the block would be delivered verbatim to any platform that receives the same reply, it can
  be validated only after the reader sees it, and the agent cannot learn whether it
  rendered.
- **json-render's inline JSONL patch stream** (`catalog.prompt({ mode: 'inline' })`). The
  daemon chunks text at paragraph boundaries for every platform, so JSONL lines would be
  split, and they would leak onto non-Console surfaces. Streaming a card while it is built
  is not worth a second output channel in v1.
- **An MCP App in a sandboxed frame.** This works for third-party servers, but it is the wrong
  shape for first-party structured output: the agent would author HTML, the card would
  occupy a live slot, and every interaction would go through a bridge.
- **A hand-written recursive renderer without json-render.** This is enough for v1's static
  catalog. json-render is chosen so that the spec format and the renderer already match
  what later versions need (§10, §12).
- **A Control Plane admin MCP tool.** This would route agent output through the Control
  Plane, contrary to §8.

## 12. Scope, validation, and open questions

### v1 scope

- Protocol: the schemas, the press event, and the feature constant.
- Relay: the feature advertisement.
- Daemon: the tool and its gates, the press derivation, and the readers excluded in §4.
- Web: the renderer, with a lint rule (`no-restricted-imports`) so that nothing outside
  `components/console/ui-spec/` imports `@json-render/*`.
- Text: the `getToolGuide` entry, and a [product conventions](../product-conventions.md)
  entry stating that cards appear only for Console readers and that a press is recorded as
  a press, not as typed words.
- Threat model: an entry in `.oss-scanner/threat_model.md` for agent-authored native
  content and the reader-attributed press.

### Validation

- Protocol unit tests accept the example spec and reject: an unknown component, an extra
  prop, a `$state` expression, a non-`Card` root, a nested `Card`, a child type its parent
  does not allow, a dangling child, a shared child, a cycle, an unreachable element, a
  duplicate button `id`, a `javascript:` URL, and each size limit.
- Daemon unit tests cover:
  - the tool absent without the relay feature;
  - refusal outside a webchat turn, in a console continuation, and on a turn with any
    `apiProtocol`;
  - zod issues returned as a tool error;
  - a valid call opening exactly one card and one app row, with `orgId` taken from the
    agent's organization;
  - no `LiveAppRegistry` entry, and a UI spec row that `reviveAppRow` never revives;
  - the receipt not parsing as an intent;
  - a press deriving `value`, or `label` when `value` is absent, from the stored row,
    recording provenance on the user turn, and refusing an unknown card, an unknown
    button, a card from another conversation, or a card of another agent;
  - a press admitted like a composer message: the relay-stamped author, queued behind a
    running turn and acknowledged as accepted, and in the card's thread;
  - a repeated `pressId` starting no second turn.
- Relay unit tests cover a press whose `agentId` is not on the conversation's roster being
  refused before it is forwarded.
- Web tests cover:
  - every component renders, and `Text` Markdown skips raw HTML;
  - an invalid persisted spec degrades to the notice;
  - a UI spec card registers no pending action and shows no Waiting or Done state;
  - a press sends only `{ agentId, appId, buttonId, pressId }`, disables the buttons only
    after it is accepted, and leaves them enabled with the reason after a refusal;
  - a retry of the same press reuses its `pressId`;
  - buttons are disabled without a live socket;
  - a press renders in the transcript as a press.
- Acceptance: a local webchat conversation in which Claude and Codex each show a card,
  repair a deliberately invalid spec after the refusal, and continue after a button press.
  Check the result on mobile and in dark mode.

### Later candidates

These are not designed here. Each needs its own review.

- Platform renderers through `uiCards` (§10).
- `Image`, after a decision on fetching agent-chosen hosts, and `Chart`.
- Local state and form inputs (`$state`, `$bindState`, text and select inputs) with a
  `submit` action, in the Console only, since chat cards have no inputs.

### Before the build PR

A spike against the pinned json-render version settles three questions. Its results are
recorded here before implementation starts. If the library does not fit, v1 falls back to
the hand-written renderer from §11, and the spec format does not change.

- json-render's exact element-level event binding (`on.press` or button props).
- Whether `defineCatalog` accepts the protocol package's zod schemas. Both sides use zod 4,
  and the workspace should resolve one instance.
- The `Table` `align` shape, and any other prop where the protocol schemas differ from
  `standardComponentDefinitions` in the pinned `@json-render/chat` version, so the
  alignment claimed in §3 holds.
