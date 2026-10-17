# Cross-platform feedback relay

This v1 arena checks Discord → Slack → Discord delivery and feedback adoption using the existing production daemon and `sendMessage` tool. It does not contact real Slack or Discord accounts: their network connections are virtual arena adapters. The referee presents only packets that an agent actually delivered; it never repairs a bridge report or injects feedback before the request arrives.

Two seats participate: `bridge` owns Discord and Slack integrations; `reviewer` owns only Slack. The origin request specifies quantity, format, source ID and return coordinates. The reviewer receives a seeded private feedback fixture only after the bridge forwards the unchanged request. After the reviewer posts its feedback, the bridge must apply it and send a report back to Discord.

## Scenarios and scoring

| Variant     | Feedback fixture                                  | Required response                                                    |
| ----------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `clean`     | One revision-1 update changes quantity and format | Revised values, original request IDs, feedback evidence ID           |
| `stale`     | Revision 1 followed by an obsolete revision 0     | Use the highest revision rather than the last array element          |
| `duplicate` | Same feedback record repeated in the packet       | Apply once and cite each ID once                                     |
| `conflict`  | Two incompatible values at revision 1             | `needs_clarification`, both evidence IDs, no fabricated final values |

Duplicate and stale fixtures manipulate **feedback content**, not transport delivery. These cases do not measure network deduplication, retries, agent dropout, concurrent reviewers, or latency fault tolerance. The referee dispatches observed packets as new arena ingress and supplies explicit destinations; peer wake-up and autonomous target discovery need separate tests.

The report uses one line: `RELAY_REPORT {"caseId":"...","sourceId":"...","status":"completed","quantity":3,"format":"json","evidenceIds":["..."]}`. Conflict reports omit `quantity` and `format` and use `status: "needs_clarification"`.

`outcome.completed` means the scenario was handled correctly. `taskCompleted` is true only for a correct, conflict-free final result; `clarificationReported` identifies correctly surfaced conflicts. Do not combine clarification success with actual user-task completion in aggregate reporting. The three-stage partial score distinguishes delivered request, delivered feedback and correct returned report. A delivered but incorrect report ends with `incorrect_report`, not an infrastructure error.

Metrics include delivery at each stage, source/evidence/status correctness, requirement satisfaction, malformed packets, incorrect addressing and invalid reports. The runner also retains its standard run manifest, token accounting and latency. This v1 does not claim CCE or a calibrated semantic judge: requirements and evidence are checked deterministically. Request IDs and feedback IDs are synthetic fixture identifiers, not authenticated provider message references. No private-context canary is injected in this suite.

Cross-platform tool sends intentionally target channel roots with explicit platform, integration and channel. They do not reuse the cross-room counting benchmark's unregistered destination thread. Thread-conversation fidelity remains covered by the existing cross-room tests, including the documented product limitation.

## Run

```bash
# Deterministic scoring, referee and real-daemon/scripted-ACP integration contracts.
pnpm exec vitest run evals/test/relay-feedback.test.ts

# Four relay smoke cases are included in the normal collaboration suite.
pnpm eval:collab

# Twenty cases: four feedback variants × five fixed seeds.
AGENTCONNECT_EVAL_GAME_CONFIG=evals/relayconfig.yaml pnpm eval:collab

# Repeat the matrix to measure variability with real ACP subjects.
export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/disposable-subject
export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=bridge-template,reviewer-template
AGENTCONNECT_EVAL_GAME_CONFIG=evals/relayconfig.yaml pnpm eval:collab -- --repeat 3
```

Use the disposable template requirements in [README.md](README.md). The selected seats must have explicit pinned runtime/model settings and the production tools available. Scripted success proves the engine contract, not model reliability. Real subjects are preflighted and use the same referee and fixtures without the scripted policy. Record subject versions, the exact case manifest, run coverage and raw evidence before comparing configurations.

The daemon requires local Unix-domain socket creation on POSIX. A restricted execution host that rejects socket binding cannot run the integration contracts; do not reinterpret `EPERM` as a model failure or an observed completion rate. Live Slack/Discord verification additionally requires a disposable connected workspace and explicit room targets; it is outside this offline arena.
