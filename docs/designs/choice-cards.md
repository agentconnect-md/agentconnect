# Choice cards

A choice card is a message with one to five buttons, and optionally an editable
text field with a "Send edited" button. Unlike a question in an agent's reply,
the card outlives the turn that posted it and survives a daemon restart. The
first permitted press settles it and starts a new turn in the card's thread, as
the person who pressed. Issue #3583 proposed it; the REST routes are the second
route family of the daemon's local API ([local-doorbell.md](local-doorbell.md)).

## Who may press

A press is the same as that person writing in the conversation: it starts a turn
as them and grants nothing. So it is judged as a message would be, never as an
approval, and the "What people can do in chat" level does not apply
([product-conventions.md](../product-conventions.md)). Core judges a press
before it touches the card, in this order:

1. A bot never presses (`actor.isBot`); it is refused without a word.
2. The conversation must be open (`chatSurface === 'open'`): not switched off,
   admitted per message by a Decision, routed, or shared with another
   organization.
3. The person must be allowed (`chatActor === 'allowed'`): anyone where
   permissions are not synced, else only a linked Agent editor.

A refusal is told only to the presser, through the facet's `tellPrivately`
(on Slack an ephemeral message); where a surface has none, `click()` returns the
text to the ingress. The card is not claimed and stays as everyone sees it.

## States

```
open ──press (judged)──▶ deciding ──turn admitted──▶ decided ──PATCH──▶ sending | sent | skipped | stale | expired
  ▲                          │
  └──turn not admitted───────┘  (generation + 1, press forgotten, presser told to press again)
```

- `open` takes presses. `deciding` records the press (`choice`, `clickedBy`,
  `clickedByName`, `editedText`) while its turn is handed to the agent.
- The turn is dispatched with `requireDurable`, the deterministic delivery id
  `card:<cardId>:<generation>` as `msgId` and inbox row id, and a permanent
  receipt `card:<cardId>:<generation>:receipt`. The card becomes `decided` inside
  the admission fence (`onAdmission`).
- When dispatch refuses the turn, resolves before admission or throws, the card
  reopens under the next generation, so a later press never meets the earlier
  press's inbox row as a duplicate.
- Startup sweep, after platform connections open and before durable replay: each
  card of a served agent left `deciding` is `decided` when the inbox row or its
  receipt exists, else reopened and redrawn.
- An open card past its `expiresAt` turns `expired` at the next press instead of
  taking it.
- A caller may set only a settled state (`decided`, `sending`, `sent`, `skipped`,
  `stale`, `expired`) and a status `label`. It may not set `open` or `deciding`,
  and may not change a card while it is `deciding` (409). Re-arming means
  posting a new card. A decided card's press record is never overwritten.

## Surface

`TurnOutputSurface.choiceCards?: ChoiceCardFacet`
(`daemon/src/platforms/choice-card.ts`), beside `elicitCards`, `approvalCards`
and `capabilityCards`. Core looks it up with `TurnOutputRegistry.exact(platform)`
and never names a platform. A facet has `post`, `redraw`, optional
`tellPrivately`, and `serves(conn)`, which declines a connection whose presses
cannot reach the daemon. Slack implements it in `platforms/slack/choice-card.ts`
(action ids `ac_card:<i>` with value `<cardId>|<optionId>`, `ac_card_edit`) and
declines a send-only (HTTP, relay-ingress) app, because the relay forwards no
`ac_card` action yet. Where the facet is absent or declines, creating a card
answers 409 and nothing is posted.

## Agent tools

`postChoiceCard`, `readChoiceCard`, `updateChoiceCard`. They are offered only
to a session whose platform declares the `choiceCards` port in
`platforms/read-ports.ts`, before any connection exists (integration-plugin
architecture §7.1); Slack declares it, and a test pins the declaration to the
registered facet. `postChoiceCard` posts into the session's own conversation
and thread, as the agent's reply would be; the model names no place. The other
two reach only cards the same agent posted, and `updateChoiceCard` takes the
same closed state set as `PATCH`.

## REST routes on the local socket

`POST /v1/cards`, strict JSON:

```json
{
  "agent": "<agent id>",
  "target": "<doorbell id the agent declares>",
  "thread": "<optional thread in the target's channel>",
  "title": "…",
  "body": "<optional>",
  "options": [{ "id": "send", "label": "Send" }],
  "editText": "<optional>",
  "expiresAt": 1790000000000
}
```

The place is the declared doorbell target, resolved as `POST /v1/doorbell`
resolves it; a free-form channel is refused (400). Without `thread`, the card
posts at top level and its presses run in the card's own thread.

| Status | Meaning                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| 201    | posted; the body is the card                                                                                    |
| 400    | the body fails the schema, or option ids repeat                                                                 |
| 404    | unknown agent, or the agent declares no such doorbell                                                           |
| 409    | the agent is served by another member, the doorbell names no integration, or the platform cannot show this card |
| 502    | the platform refused the post                                                                                   |

`GET /v1/cards/:id` answers 200 with the card or 404. `PATCH /v1/cards/:id`
takes `{ "state"?: <settled state>, "label"?: string | null }` (at least one)
and answers 200 with the card, 400, 404, or 409 while the card is `deciding`.

The card body: `{ id, channel, thread, ts, state, label?, choice?, clickedBy?,
clickedByName?, editedText?, decidedAt? }`.

## Store

Table `choice_card` (`daemon/src/store/choice-cards.ts`), keyed by `cardId`:
the place (`agentId`, `integrationId`, `platform`, `channel`, `thread`, `isDm`,
`ts`), the content (`title`, `body`, `optionsJson`, `editText`, `expiresAt`),
the state (`state`, `generation`, `label`) and the press (`choice`, `clickedBy`,
`clickedByName`, `editedText`, `decidedAt`). Claim, decide and reopen are
compare-and-set updates on `state` and `generation`.

## Not in scope

- Relay forwarding of `ac_card` actions, which would let an HTTP-mode Slack app
  show cards.
- Card facets for platforms other than Slack.
