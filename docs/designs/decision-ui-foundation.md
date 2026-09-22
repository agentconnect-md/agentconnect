# Decision UI foundation

This is the implemented starting point for a mock Console UI, tracked in
[#2228](https://github.com/agentconnect-md/agentconnect/issues/2228). The
[Decisions design](decisions.md) defines the intended live behavior. Shared-bot
routing remains Stage 2 even though its configuration can be prototyped now.

## Available code

| Module                                       | Provides                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@agentconnect.md/protocol/decision`         | Zod question/draft/answer/condition/routing schemas, question-aware validation, pure matchers, and edit invalidation              |
| `@agentconnect.md/protocol/decision-api`     | Browser-safe API types, provider/model catalog and readiness, channel settings, routing scope, preview request/result, and errors |
| `packages/web/src/lib/decisions/mock-api.ts` | Opt-in `createDecisionMockApi()` implementing `DecisionApi` with isolated in-memory saves                                         |
| `packages/web/src/lib/decisions/fixtures.ts` | Example Decisions, direct/shared bots, channels, provider options, canned evaluations, and repeated-mention context               |

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

Provider configuration belongs to the daemon environment or secret-backed host
configuration. The API exposes only catalog IDs, supported models/question types,
BYOK versus AC credits, and readiness. Each Decision keeps its own model selection.
There is no endpoint/key editor, provider credential mutation, ACP runtime picker,
or revision field in this contract. Catalog IDs are resolved on the evaluation
daemon; equal logical IDs can use different daemon-local credentials.

`createDecisionMockApi({ scenario })` supports `ready`, `missing_credentials`,
`needs_review`, `provider_unavailable`, `pending_sync`, `daemon_offline`, and
`insufficient_credits`. The default catalog includes BYOK and AC credits. Scenarios
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
mock as a fallback for failed production requests. The mock has no navigation entry
or completed screens. The next UI change builds forms and flows on these contracts;
live Stage 1 and Stage 2 each still require their backend and runtime milestones.

Focused validation:

```sh
pnpm --filter @agentconnect.md/protocol exec vitest run src/decision.test.ts --maxWorkers=1
pnpm --filter @agentconnect.md/web exec vitest run src/protocol-imports.leaf.test.ts src/lib/decisions/mock-api.test.ts --maxWorkers=1
```
