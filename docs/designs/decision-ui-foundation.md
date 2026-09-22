# Decision UI foundation

This is the implemented starting point for a mock Console UI, tracked in
[#2228](https://github.com/agentconnect-md/agentconnect/issues/2228). The
[Decisions design](decisions.md) defines the intended live behavior. Shared-bot
routing remains Stage 2 even though its configuration can be prototyped now.

## Available code

| Module                                                             | Provides                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `@agentconnect.md/protocol/decision`                               | Zod question/draft/answer/condition/routing schemas, question-aware validation, pure matchers, and edit invalidation              |
| `@agentconnect.md/protocol/decision-api`                           | Browser-safe API types, provider/model catalog and readiness, channel settings, routing scope, preview request/result, and errors |
| `packages/web/src/lib/decisions/mock-api.ts`                       | Opt-in `createDecisionMockApi()` implementing `DecisionApi` with isolated in-memory saves                                         |
| `packages/web/src/lib/decisions/fixtures.ts`                       | Example Decisions, direct/shared bots, channels, provider options, canned evaluations, and repeated-mention context               |
| `packages/web/src/lib/decisions/provider.tsx`                      | The console's one mock instance, the shared decision list, and the prototype channel gate bindings                                |
| `packages/web/src/components/console/decisions/`                   | The condition editor, the per-conversation `By decision` gate strip, and the flag-off notice                                      |
| `packages/web/src/components/console/views/DecisionsView.tsx`      | The Decisions list (`/decisions`)                                                                                                 |
| `packages/web/src/components/console/views/DecisionEditorView.tsx` | One decision's editor and example sandbox (`/decisions/new`, `/decisions/:id`)                                                    |

Import runtime schemas from `protocol/decision`; import API contracts from
`protocol/decision-api` with `import type` so the browser never resolves its relative
type references. Keep one mock API instance for the
prototype's lifetime, for example in a React state initializer or prototype provider;
creating an instance on each render resets saved state. Returned objects are copies,
so editing or cancelling a form never changes saved state until a save method succeeds.

```ts
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'
import { createDecisionMockApi } from '@/lib/decisions/mock-api'

const api: DecisionApi = createDecisionMockApi()
const definitions = await api.listDecisions()
const providers = await api.listProviders('example-daemon')
const routing = await api.getRouting('support-bot')

const { decision } = await api.getDecision('support-category')
const preview = await api.preview({
  decision: {
    name: decision.name,
    providerId: decision.providerId,
    model: decision.model,
    question: decision.question,
    visibility: decision.visibility,
    sharedWith: decision.sharedWith
  },
  daemonId: 'example-daemon',
  state: { history: [], currentMessage: { text: 'My billing API request failed.' } },
  consumer: {
    type: 'shared_bot_routing',
    botId: 'support-bot',
    channelId: 'help-channel',
    channelIds: routing.channelIds,
    config: routing.config!,
    targets: { type: 'new' }
  }
})
// The fixture produces billing=.4, technical=.4, sales=.2; both .3 rules match.
```

For standalone preview, use `consumer: { type: 'none' }`. For a fixed-target gate,
pass `{ type: 'gate', channelId, when }`. A routing preview accepts the draft config
and draft scope (`channelIds`) without saving either; `channelId` selects the sample
channel. Otherwise and provider-failure continuation use that channel's resolved
default agent. Off, outside-scope, and paused routing return `not_applied` with a
`notAppliedReason` and no evaluation. Channels must belong to the selected shared bot.
Use `targets: { type: 'thread', agentIds: [...] }` or `mention`
to demonstrate constrained recipients. Compare `matchedAgentIds` with
`effectiveAgentIds`: an activating answer preserves existing/addressed recipients;
a skip still skips. `unavailableAgentIds` identifies selected targets that cannot
currently receive the message; it does not select substitutes.

Previews use canned model answers, explicitly marked `mode: 'mock'`, and the real
consumer matcher. They do not infer anything from sample text. Editing thresholds
or intervals changes matching; use an injected `evaluate(decision, state)` function
to supply another model result. The full distribution is validated before matching.
Invalid fixture output becomes `unavailable`, never an invented negative answer.

## Forms and saves

- Use `DecisionDraft.safeParse` for the resource form and `decisionConditionIssues`
  or `decisionRoutingIssues` for question-dependent inline errors. Error paths point
  to fields or routing rows. Choice/Boolean gates can select none; routing rules cannot.
- `updateDecision` preserves saved `visibility` and `sharedWith` when omitted.
  Only explicitly supplied sharing fields change the audience; creation keeps its defaults.
- Choice thresholds use `[0, 1]` in the contract and percentages in UI. All passing
  rules contribute actions and target IDs are deduplicated. A matched skip does not
  invoke Otherwise or veto a matched agent action.
- Score ranges use `[min, max)`, with the rubric maximum included. Sort rows by
  lower bound for display. Reject overlaps and show gaps as Otherwise.
- `saveChannel` accepts a complete trigger setting. Off/Mention/Any removes the
  Decision binding. Shared-bot scope additions use `saveRouting`.
- `saveRouting` accepts the complete selected `channelIds` and explicit replacement
  settings for every removed channel. Validation happens before any change; adding
  an Off channel fails without changing the routing or other channels.
- Incompatible Decision edits preserve saved consumer conditions as Needs review.
  Changing a Score rubric's length invalidates even an interval that still fits.
  Saving the repaired consumer clears that state. Deleting a used Decision returns 409.
- A failed binding save preserves an already-created Decision. `beforeSave` can
  throw a simulated error to exercise Retry and draft preservation.

## Provider ownership and scenarios

Organization owners configure keys in **Infra → Provider keys**, backed by the
real organization-scoped REST API. The Decision API remains a secret-free catalog
projection: one logical provider ID, supported models/question types, the resolved
BYOK or AC-credits source (or `null` when unconfigured), and readiness. Each Decision
keeps its own model selection. The Decision editor does not own key mutation or an
endpoint editor. See [credential resolution](./decisions.md#provider-keys-and-credential-resolution)
for the real configuration surface and the remaining daemon/Cloud integration.

`createDecisionMockApi({ scenario })` supports `ready`, `ac_credits`,
`missing_credentials`, `needs_review`, `provider_unavailable`, `pending_sync`,
`daemon_offline`, and `insufficient_credits`. The default catalog resolves
`typesafe` to BYOK; Cloud scenarios use the same provider ID with `ac_credits` as
the resolved source. These fixtures do not read or use the real saved key. Scenarios
show configuration readiness separately from an attempted evaluation returning
`unavailable`; the latter previews eligible continuation to constrained/default
recipients rather than a successful match.

Use `createDecisionMockSeed()` to customize agents, channels, questions, or saved
conditions before constructing the service. Mark an agent `available: false` to
exercise target-unavailable presentation. For repeated-mention suppression, pass
`evaluateRepeatedMentionFixture` as `evaluate` and `repeatedMentionFixture` as state
with the Boolean Decision and a Yes gate. This is a canned skipped mention, not a
claim that spam detection has been implemented or validated.

## Delivery boundary

The service has no network access, durable storage, real authorization, history
collection, Jev calls, admission/steering, relay forwarding, or credit charging.
Its seed represents an already-authorized organization view; the live API must
enforce visibility and membership. Mock previews do not write evaluation history.
Cloud entitlement and charging contracts remain separate implementation work.

Production HTTP handlers and trigger/capability frames are unchanged. UI components
can depend on `DecisionApi` and later use a real implementation; never install this
mock as a fallback for failed production requests. The decisions routes, the rail
entry, and the `By decision` trigger option all sit behind the `decisions` feature
flag, so an unconfigured deployment neither shows nor reads the prototype.

## Console surface

`DecisionsPrototypeProvider` is mounted once inside the console shell, below
`ConsoleDataProvider`, so the store outlives every route: a decision created on the editor
is still there when a conversation row binds it. Because that outlives an **organization
switch** too, the organization is part of its state and not merely of a row key — the mock
API instance, the cached decision list, and the exposed gate usages are all partitioned by
`activeOrg.id`, so one tenant's definitions and consumers never reach another's `Used by`,
edit warnings, or delete guard. Switching back finds the previous tenant's partition intact
rather than reset.

- `/decisions` lists the visible definitions — name, question type, provider/model,
  `Used by`, updated — with search, duplicate, and a delete that refuses a decision a
  consumer still uses. A prototype gate counts as a consumer here, because the mock
  service cannot see it.
- `/decisions/new` and `/decisions/:id` edit the resource: name, provider, model,
  question type, instructions, and the criteria editor for the selected type. Score
  levels are re-keyed from their position on every move or removal. **Try with an
  example** runs the canned evaluator through `preview` with `consumer: { type: 'none' }`,
  reports the typed answer and the per-key distribution, and marks a result stale once
  the draft changes under it.
- The agent's conversation rows gain `by decision` as a fourth trigger. Picking it
  opens the gate editor beneath the row: the decision picker (with **Create decision**),
  the **Trigger when** condition editor for the question type, the three explanation
  notes, and **Try a message**, which matches the condition locally with
  `matchDecisionCondition` against the preview's answer. Its verdict is its own block, so
  collapsing the disclosure keeps the result on screen. The CP's
  `IntegrationChannelDto.trigger` is never written with `decision` — the binding lives in
  the provider, keyed by organization, owning bot, and conversation.
- The gate is offered on a **single-owner** bot's group rooms only. A shared bot's consumer
  is that bot's own routing rules (§3.2), and one delivery cannot carry both consumers — so
  until the router ships the choice is withheld there rather than offering a gate the
  design says cannot apply.

Still unimplemented: the shared-bot routing screen and its evaluation log (Stage 2),
prototype-local gates surviving a reload, and every live Control Plane route, projection,
and daemon-side evaluation the design specifies. `usedBy.kind.shared_bot_routing` is
localized ahead of that work.

Focused validation:

```sh
pnpm --filter @agentconnect.md/protocol exec vitest run src/decision.test.ts --maxWorkers=1
pnpm --filter @agentconnect.md/web exec vitest run src/protocol-imports.leaf.test.ts src/icon-names.test.ts src/lib/decisions src/components/console/decisions src/components/console/views/DecisionsView.test.tsx src/components/console/views/DecisionEditorView.test.tsx --maxWorkers=1
pnpm --filter @agentconnect.md/web i18n:check
```
