# Decision Console and mock fixtures

This describes the live Decision Console and its explicit mock mode, tracked in
[#2228](https://github.com/agentconnect-md/agentconnect/issues/2228). The
[Decisions design](decisions.md) defines the intended live behavior. Shared-bot
routing remains Stage 2 even though its configuration can be prototyped now.

## Available code

| Module                                                             | Provides                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentconnect.md/protocol/decision`                               | Zod question/draft/answer/condition/routing schemas, question-aware validation, pure matchers, and edit invalidation                                 |
| `@agentconnect.md/protocol/decision-api`                           | Browser-safe API types, provider/model catalog and readiness, channel settings, routing scope, preview request/result, and errors                    |
| `packages/web/src/lib/decisions/mock-api.ts`                       | Opt-in `createDecisionMockApi()` implementing `DecisionApi` with isolated in-memory saves                                                            |
| `packages/web/src/lib/decisions/fixtures.ts`                       | Example Decisions, direct/shared bots, channels, provider options, canned evaluations, and repeated-mention context                                  |
| `packages/web/src/lib/decisions/provider.tsx`                      | Organization-scoped live/mock APIs, shared Decision list, route-surviving binding drafts and inline-create handoff, and mock-only channel gates      |
| `packages/web/src/lib/decisions/binding.ts`                        | Saved gate, readiness status, and save-error projections of the channel DTO and API errors                                                           |
| `packages/web/src/lib/decisions/evaluations.ts`                    | Recent evaluations projections: answer text, outcome tone, reason keys, and latency                                                                  |
| `packages/web/src/lib/decisions/usage-links.ts`                    | Console destinations for Decision usages                                                                                                             |
| `packages/web/src/components/console/decisions/`                   | The condition editor, the per-conversation `By decision` binding strip with gate Try and Recent evaluations, the usage list, and the flag-off notice |
| `packages/web/src/components/console/views/DecisionsView.tsx`      | The Decisions list (`/decisions`)                                                                                                                    |
| `packages/web/src/components/console/views/DecisionEditorView.tsx` | One decision's editor and example sandbox (`/decisions/new`, `/decisions/:id`)                                                                       |

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

## Mock consumer forms and saves

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
for the real configuration surface and the callable daemon evaluator. The latter
reuses existing Cloud token issuance; it is not connected to this mock API.

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

The mock service has no network access, durable storage, real authorization, history
collection, Jev calls, admission/steering, relay forwarding, or credit charging.
Its seed represents an already-authorized organization view; the live API must
enforce visibility and membership. Mock previews do not write evaluation history.
The live daemon evaluator delegates Cloud authorization and charging to the
existing Key Server/gateway contract; these fixtures exercise neither service.

The live `DecisionApi` is `createDecisionApi(orgId)` in `lib/api.ts`. It captures the
organization for every read and write and uses the normal authenticated HTTP client.
The provider selects this API unless `NEXT_PUBLIC_MOCK` is explicitly enabled. A failed
production request surfaces its error; it never installs mock data. The `decisions`
feature flag controls the routes, the rail entry, and the By decision option. Live
bindings bypass `DecisionApi`: rows read `trigger`, `decisionBinding`, and the `decision`
readiness view from the integration channel DTO, and save through
`PATCH /integrations/:id/channels/:channelId` (`updateIntegrationChannel`).
`DecisionApi.saveChannel`, `listChannels`, `listBots`, and the routing methods stay
mock-only. Three conversation methods are live on both implementations:
`previewGate(ref, { decisionBinding, state })` posts to
`POST /integrations/:id/channels/:channelId/decision-preview`
(`previewIntegrationChannelDecision`), and `listEvaluations(ref, { cursor, limit })` and
`getEvaluation(ref, seq)` read `GET …/decision-evaluations` and `GET …/decision-evaluations/:seq`
(`listIntegrationChannelDecisionEvaluations`, `getIntegrationChannelDecisionEvaluation`). A
`ref` is `{ integrationId, channelId }`. The mock seed carries canned `evaluations`, one per
outcome (Triggered, Skipped, Unavailable, Canceled, Pending) plus a row whose bodies are
already stripped (`detailsExpired: true`); the `needs_review` scenario answers gate previews
Not applied and `daemon_offline` answers 503.

## Console surface

`DecisionsPrototypeProvider` is mounted inside the Console shell and partitions both
the API and SWR cache by organization. Live definitions survive browser reloads. Mock
instances and prototype gates survive route navigation but are not durable. Editor/list
state resets on an organization switch so a draft or deletion dialog cannot carry over.

- `/decisions` lists visible definitions, with search, duplicate, and delete. Server-provided
  editing authority and the organization role gate actions. Used by counts conversation
  gates and agent tools. Usage lists link a gate to its agent's Integrations tab, an agent
  tool to `?tab=tools`, and model selection to `?tab=config`; shared-bot routing has no link
  yet. A delete refused with 409 lists the returned usages plus "N more you cannot see"
  from `hiddenUsageCount`.
- `/decisions/new` and `/decisions/:id` edit the typed question, model, and Team visibility.
  Unchanged sharing is omitted from PATCH. Saving needs no online daemon.
- **Try with an example** selects a daemon from the live catalog and sends history/current
  message through `preview` with `consumer: { type: 'none' }`. It displays actual typed
  answers, model, probabilities, and provider failures. Changes to the question, sample,
  or daemon mark prior results stale. The feature does not collect platform history.
- Provider readiness comes from the authorized daemon and organization provider-key
  metadata; only the daemon evaluates. The adapter's shipped catalog supports Jev 1.13
  and its stable/preview aliases. Preview needs a visible currently served agent for the
  existing credential/token attribution contract, but does not execute that agent.
- Group conversation rows on single-owner bots offer **By decision** where the platform's
  channel-list `triggers` allow it (Linear omits it, matching the CP's `ownerAsDefault`
  refusal). The strip reads Decision → Trigger when → Activates: [the row's agent]. Save
  sends trigger and gate in one PATCH; Cancel restores the saved row; switching to
  Off/Mention/Any sends the ordinary trigger PATCH, which clears the gate. Drafts live in
  the provider, keyed by organization, bot, and conversation, so an inline Create decision
  returns to the draft with the new Decision selected, and a failed save keeps the draft
  (and the created Decision) for Retry. Save errors map to field issues (400), no
  permission (403), Decision not available (404 `DECISION_NOT_FOUND`), and an upgrade
  message (409 `DECISION_UNSUPPORTED_CONSUMER`).
- A saved gate shows its status: Pending sync, Needs review (Repair condition and Open
  decision), Daemon offline, Unsupported, or Access revoked (Choose another decision);
  Ready has no banner. Shared-bot rows do not offer By decision; a shared-bot routing
  binding reads **Managed by [bot] routing**, linked to the bot's integration page.
- **Try a message** in the gate editor runs `previewGate` on the conversation, not on a
  daemon the operator picks: the CP resolves the consumer's serving daemon, evaluates the
  draft on it, and applies the draft condition. The sample is ordered history lines with
  sender ids plus the current message. The result reads answer → condition → Would trigger
  [target] or Would skip; a provider failure shows Evaluation unavailable, continuing to the
  target, never a skip; Off, Unsupported, and Needs review show Not applied with no model
  call. Any edit to the Decision, condition, or sample dims the result and marks it stale.
  Viewers do not see Try.
- A saved gate offers **Recent evaluations**, also to viewers who can read the conversation.
  The list shows Time, Answer, Matched, Outcome (with its unavailable or cancel reason), and
  Latency, stacks below the desktop breakpoint, and pages with Load more. A row opens the
  detail sheet: the frozen question and condition, the evaluated message and history with
  sender ids, requested and actual model, usage, context, answer, and evidence. Once retention
  stripped the bodies it says **Details expired** and keeps the summary. 503 reads as an
  offline daemon or, for `DAEMON_UPGRADE_REQUIRED`, an upgrade prompt.
- Explicit mock mode runs the same strip against local prototype gates, using the real
  pure matcher with canned answers.

Still unimplemented: the shared-bot routing screen, with its routing preview and
routing evaluation history. See the
[current delivery boundary](decisions.md#104-rollout-and-remaining-implementation-work).

Focused validation:

```sh
pnpm --filter @agentconnect.md/protocol exec vitest run src/decision.test.ts src/frames/decision.test.ts --maxWorkers=1
pnpm --filter @agentconnect.md/daemon exec vitest run test/decision-evaluations.test.ts --maxWorkers=1
pnpm --filter @agentconnect.md/web exec vitest run src/protocol-imports.leaf.test.ts src/icon-names.test.ts src/lib/decisions src/lib/integration-row.test.ts src/components/console/decisions src/components/console/IntegrationChannelList.decisions.test.tsx src/components/console/views/DecisionsView.test.tsx src/components/console/views/DecisionEditorView.test.tsx --maxWorkers=1
pnpm --filter @agentconnect.md/web i18n:check
```
