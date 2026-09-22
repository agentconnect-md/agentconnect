# Context

Ubiquitous language for AgentConnect. Glossary only — no implementation detail, no decisions.
Decisions live in `docs/designs/`.

## Message intake

**Channel record** — the daemon's durable record of what was said in one platform conversation,
independent of whether any agent responded. One entry per inbound message per conversation.
It is not a session's history; a session's history is a view over it.

**Observation** — an entry in the channel record that no agent has taken in. It is evidence: a
Decision may read it, and a later activation may be given it as background. It names no session.

**Admission** — the act of an agent taking a message into one of its sessions. One message may be
admitted by several agents, each into its own session. An entry with no admission is an
observation; the same entry gains meaning for each agent that admits it.

**Observation window** — the bounded, most-recent slice of one conversation's channel record that
is supplied to a Decision as state. Bounded by count and by the evaluator's input budget.

**Session mode** — one agent's choice, for one conversation, of how the messages it admits there
key their sessions: each top-level message starts a new one, or every message joins one ongoing
one. Two agents in the same conversation may choose differently, so the mode is only known once
the target agent is.

## Coordinates

**Delivery coordinate** — where an answer is posted: the platform conversation and, where the
platform has them, the thread the triggering message arrived in. Always the physical location.

**Session coordinate** — which session an admitted message joins. In the default mode it is the
thread; in append mode it is a conversation-wide coordinate that belongs to no thread. It is
never a posting target.

**Thread participation** — the fact that an agent has taken part in one physical thread: it was
delivered a message there or posted into it. Independent of which session that work belongs to.
A reply into a thread the agent participates in continues that agent's work without being judged
again.

## Judgment

**Decision** — a reusable, organization-owned typed judgment: a question plus what its answers
mean. It owns no trigger and no target agent.

**Consumer** — a feature that evaluates a Decision with its own state and acts on the answer. A
conversation's activation gate and a shared bot's router are the first two.

**Evaluation host** — for a conversation whose routing is judged once for several candidate
agents, the one daemon that performs that judgment and then distributes the result. An internal
execution role, not an agent and not a user-facing choice.
