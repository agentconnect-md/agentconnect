/**
 * Cross-surface activation parity spec.
 *
 * "Who does this message activate" is implemented more than once — the daemon
 * platform ladder (`packages/daemon/src/router/routing-table.ts` + the verified
 * agent-author ladder in `daemon.ts`), the relay's arbitration for relayed
 * platform ingress (`packages/relay/src/bot-arbitration.ts`, "same rules" per
 * send-message-routing-rework.md §6), and webchat multi-agent activation
 * (roster/standing-mention semantics, webchat-multi-agents.md §4.2/§5.2a).
 * The webchat copy missed the #549 policy change for months (issue #904, fixed
 * by PR #906) — this spec exists so that can't happen silently again.
 *
 * One scenario vocabulary, several legs: each scenario is DATA (an invariant
 * plus per-surface expected outcomes); the per-surface test legs
 * (`evals/test/parity-slack.test.ts`, `evals/test/parity-webchat.test.ts`)
 * consume this module and assert the declared outcome from the daemon's own
 * records. Where surfaces intentionally differ, the divergence is DECLARED
 * here with a design-doc citation — an undeclared divergence is a failing leg.
 *
 * Governance (docs/designs/activation-parity.md): any PR touching activation/
 * routing behavior must update this spec — either every applicable leg passes
 * with the same expectation, or the divergence is declared here with a
 * citation. Silent per-surface drift is the failure mode this file pins.
 */
import { MAX_AGENT_CALL_HOPS } from '../../packages/protocol/src/consts.js'

/** Surfaces a leg exists for today. The relay's arbitrate ladder is exercised
 *  indirectly (its rungs mirror the daemon ladder, §6) and gains its own leg
 *  when the policy module lands — the spec vocabulary already fits it. */
export type ParitySurface = 'slack' | 'webchat'

export const PARITY_SURFACES: readonly ParitySurface[] = ['slack', 'webchat']

/** Mirrors the daemon's private `MAX_AUTOMATIC_TURNS_PER_WINDOW`
 *  (packages/daemon/src/daemon.ts): automatic turns admitted per agent per
 *  `LOOP_GUARD_WINDOW_MS`. Kept as a mirrored literal for the same reason
 *  `evals/test/routing-acceptance.test.ts` mirrors it — the constant is
 *  deliberately not exported from the daemon. */
export const AUTOMATIC_TURNS_PER_WINDOW = 8

/**
 * The activation set a scenario's probe message produces, in role terms:
 *
 *  - `mentioned-only`   — exactly the agents the message explicitly named;
 *  - `roster`           — every conversation participant (standing mention);
 *  - `participants-minus-author` — everyone already in the conversation except
 *                          the (verified agent) author;
 *  - `target-exactly-once`       — the delivery's target, admitted exactly
 *                          once across echoes/retries/duplicate frames. How
 *                          the target is ADDRESSED is surface mechanics: an
 *                          explicit mention where the surface has mention
 *                          addressing (channels), the pre-addressed roster
 *                          fan-out where it does not (webchat agent posts
 *                          carry no structured mentions);
 *  - `parent-exactly-once`       — the delegating parent session, woken exactly
 *                          once by the child's report;
 *  - `nobody`           — no activation at all (transcript-only where the
 *                          surface records transcripts).
 */
export type ActivationSet =
  'mentioned-only' | 'roster' | 'participants-minus-author' | 'target-exactly-once' | 'parent-exactly-once' | 'nobody'

export interface ChainRefusal {
  /** Which protection terminates the scenario's agent-to-agent chain. */
  reason: 'hop_limit' | 'automatic_turn_budget'
  /** Agent-to-agent edges the chain runs before the refusal. */
  afterEdges: number
}

export interface SurfaceExpectation {
  activates: ActivationSet
  /** Set when the scenario runs a chain to a protection limit. */
  refusal?: ChainRefusal
  /** The leg must prove streaming/partial output produced no activation. */
  streamingNeverRoutes?: true
  /** The leg must prove the woken agent's silent decline posted nothing. */
  silentDeclinePostsNothing?: true
  /** Surface-mechanics footnote the leg additionally pins. */
  notes?: string
}

/** A per-surface difference that is intentional, with its design citation.
 *  Anything not declared here is a parity bug. */
export interface DeclaredDivergence {
  reason: string
  cites: readonly string[]
}

export interface ParityScenario {
  id: string
  title: string
  /** The invariant in one surface-agnostic sentence. */
  invariant: string
  expect: Partial<Record<ParitySurface, SurfaceExpectation>>
  /** Surfaces the scenario structurally cannot run on, and why. A surface
   *  listed here must not also carry an expectation. */
  notApplicable?: Partial<Record<ParitySurface, string>>
  divergence?: DeclaredDivergence
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    id: 'human-kickoff-activation',
    title: 'human kickoff activates the right set',
    invariant:
      'A human message entering a multi-agent conversation activates the set the surface convention defines — and only that set.',
    expect: {
      // Production shared-channel convention: mention-gated, never `auto`
      // (collaboration-arena-baseline.md §1). Only the explicitly mentioned
      // agent runs; the other channel member stays idle.
      slack: { activates: 'mentioned-only' },
      // Webchat membership is a standing mention (webchat-multi-agents.md
      // §4.2): an unnarrowed kickoff activates the whole roster, and a user
      // post's `context` copy to a non-target never activates (§5.2 —
      // user turns activate exclusively through pre-addressed `turn` frames).
      webchat: {
        activates: 'roster',
        notes: 'mention-narrowing reduces the set to the named participants; user context copies stay transcript-only'
      }
    },
    // DECLARED divergence, not a bug: a shared channel is opt-in per message
    // (mention-gated), while pulling agents into a webchat conversation is
    // "equivalent to having @-mentioned them all in its first message".
    divergence: {
      reason:
        'Channel agents are addressed per message (mention-gated shared-channel convention); webchat roster membership IS the standing mention, so a bare kickoff addresses everyone.',
      cites: ['docs/designs/webchat-multi-agents.md §4.2', 'docs/designs/collaboration-arena-baseline.md §1']
    }
  },
  {
    id: 'agent-continuation-minus-author',
    title: 'verified agent continuation activates participants minus author',
    invariant:
      'A verified agent-authored message naming nobody continues the conversation: every other participant is activated, the author never is (#549).',
    expect: {
      slack: { activates: 'participants-minus-author' },
      webchat: { activates: 'participants-minus-author' }
    }
  },
  {
    id: 'author-never-self-activates',
    title: 'the author never self-activates',
    invariant:
      'No delivery path lets an agent wake itself on its own message — not via its own mention token, not via a mis-addressed fan-out copy. This is unconditional (not a loop the hop cap merely slows).',
    expect: {
      slack: {
        activates: 'nobody',
        notes: 'a finalized reply carrying the author’s own mention token routes to no one'
      },
      webchat: {
        activates: 'nobody',
        notes: 'a context frame mis-addressed to the post’s own author is dropped with no rendezvous record'
      }
    }
  },
  {
    id: 'delivery-exactly-once',
    title: 'one committed agent message admits each target exactly once',
    invariant:
      'One committed agent message produces exactly one activation per (message, target) — duplicate frames, echoes, and retries are absorbed by the durable rendezvous.',
    expect: {
      // The addressed EDGE differs per surface by construction, and that is
      // mechanics, not outcome: channels address a peer with an explicit
      // mention; a webchat agent post carries no structured mentions, so its
      // addressed edge IS the relay's pre-addressed fan-out copy. Both must
      // collapse duplicates to one admission.
      slack: {
        activates: 'target-exactly-once',
        notes:
          'the explicit-mention edge: the streaming echo and the finalized echo of one response collapse to one admission for the named peer'
      },
      webchat: {
        activates: 'target-exactly-once',
        notes:
          'the pre-addressed fan-out edge: a re-fanned identical context copy under a fresh relay msgId does not double-wake the target'
      }
    }
  },
  {
    id: 'streaming-never-routes',
    title: 'only finalized messages route',
    invariant:
      'Streaming/partial agent output never activates anyone; activation happens only on the committed (finalized) message.',
    expect: {
      slack: {
        activates: 'target-exactly-once',
        streamingNeverRoutes: true,
        notes: 'every streaming echo admission is refused; only the response-closing edit routes'
      },
      webchat: {
        activates: 'target-exactly-once',
        streamingNeverRoutes: true,
        notes: 'structural on this surface: rd/webchat-post exists only for committed replies, streaming rides rd/chat'
      }
    }
  },
  {
    id: 'hop-transition-and-refusal',
    title: 'each agent-to-agent edge charges one hop; the chain terminates at a recorded limit',
    invariant:
      'An unattended agent-to-agent chain advances exactly one hop per edge and terminates by hitting a protection limit with a recorded refusal — never by running unboundedly.',
    expect: {
      // The durable loop guard's automatic-turn budget binds BEFORE the hop
      // cap on channels: 2 agents × 8 automatic turns per window = 16 edges,
      // then a `gated` refusal with hop budget to spare
      // (collaboration-arena-baseline.md §6.1, pinned since #628).
      slack: {
        activates: 'participants-minus-author',
        refusal: { reason: 'automatic_turn_budget', afterEdges: AUTOMATIC_TURNS_PER_WINDOW * 2 }
      },
      // Webchat mirrors Slack's agent-continuation accounting — the exact
      // trusted hop cap is the budget and the coarse loop guard is not
      // charged (webchat-multi-agents.md §5.2a "Loop accounting") — so the
      // same chain runs to the cap and the +1 transition is refused there.
      // The kickoff post is depth 0, continuations land at depths 1..cap-1,
      // so cap-1 agent-to-agent edges are admitted and the next is refused.
      webchat: {
        activates: 'participants-minus-author',
        refusal: { reason: 'hop_limit', afterEdges: MAX_AGENT_CALL_HOPS - 1 }
      }
    },
    // DECLARED divergence: which protection binds first, not whether one does.
    // Both surfaces charge the same +1 per edge against MAX_AGENT_CALL_HOPS;
    // channels ALSO charge the coarse loop guard, and at the current constants
    // that budget binds first, so the cap is unreachable for a two-agent room.
    divergence: {
      reason:
        'Channels charge the durable loop guard as well as the hop budget and the guard binds first (16 < 20); webchat deliberately charges only the exact hop cap because it has no in-band !resume surface to reset a guard latch with.',
      cites: [
        'docs/designs/collaboration-arena-baseline.md §6.1',
        'docs/designs/webchat-multi-agents.md §5.2a',
        'docs/designs/send-message-routing-rework.md §4.1'
      ]
    }
  },
  {
    id: 'silent-decline-absorbs-wake',
    title: 'a silent decline absorbs a wake without posting',
    invariant:
      'A woken participant that declines to respond produces no visible post and no transcript reply row — the wake is absorbed, and nothing further fans out from it.',
    expect: {
      slack: { activates: 'participants-minus-author', silentDeclinePostsNothing: true },
      webchat: {
        activates: 'participants-minus-author',
        silentDeclinePostsNothing: true,
        notes: 'the AC_NO_RESPONSE sentinel commits no canonical post, so nothing fans out'
      }
    }
  },
  {
    id: 'needs-reply-round-trip',
    title: 'a needsReply delegation round-trips to the parent exactly once',
    invariant:
      'A child’s report back to its delegating parent session wakes the parent exactly once, and the report body itself is never published to the conversation.',
    expect: {
      slack: { activates: 'parent-exactly-once' }
    },
    notApplicable: {
      webchat:
        'The sendMessage {sessionId: parent} report seam is the shared sessions machinery below the activation ladders; webchat conversations expose no per-scenario surface for it at the daemon-level harness. Single-implementation machinery is outside parity scope.'
    }
  },
  {
    id: 'unverified-author-no-agent-rungs',
    title: 'an unverifiable author cannot activate through agent rungs',
    invariant:
      'Only a VERIFIED agent author reaches the implicit continuation rungs. An unverifiable claim fails closed: transcript-only, no implicit activation.',
    expect: {
      slack: {
        activates: 'nobody',
        notes:
          'an unmentioned third-party bot message activates no one (no thread affinity for bot traffic); an explicit mention from it still activates on Slack, whose manifest admits bot senders — verification, not bot-ness, is the boundary (send-message-routing-rework.md §2.3)'
      },
      webchat: {
        activates: 'nobody',
        notes:
          'an agent post with no usable depth stamp (pre-parity daemon, or an authorship claim the relay could not bind and therefore stripped) stays transcript-only — a missing depth never coerces to zero (webchat-multi-agents.md §5.2a)'
      }
    }
  }
]

/** Scenario ids a leg for `surface` must implement. */
export function scenariosFor(surface: ParitySurface): readonly ParityScenario[] {
  return PARITY_SCENARIOS.filter((scenario) => scenario.expect[surface] !== undefined)
}

/**
 * The COMPARABLE outcome of an expectation — every field except `notes`, which
 * is commentary rather than contract.
 *
 * Every leg driver pins `declaredOutcome(scenario.expect[surface])` with an
 * exact `toEqual` before demonstrating the behavior, so the spec is
 * load-bearing in both directions: editing an expectation here fails the
 * driver that demonstrates the old outcome, and a behavior change fails the
 * driver's measured assertions. The divergence guard compares the same shape.
 */
export function declaredOutcome(expectation: SurfaceExpectation): Omit<SurfaceExpectation, 'notes'> {
  const { notes: _notes, ...outcome } = expectation
  return outcome
}
