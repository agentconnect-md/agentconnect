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

## Workspace materialization

**Source** — upstream content a workspace or a skill is built from: a Git repository, or a
non-Git file collection. It can always be fetched again from where it lives.

**Source Cache** — the cluster's evictable copy of Sources, held so a new pod need not fetch them
whole from upstream. Emptying it makes the next start slower and never loses anything.
_Avoid_: repo cache, download cache (when it means both kinds of stored content)

**Workspace Snapshot** — a durable capture of workspace content that exists nowhere upstream:
files an agent or user produced, including uncommitted changes. Losing one loses work.
_Avoid_: backup, cache

**Source resolution** — the trusted step that turns a Source's ref into the exact revision to
use, performed with the requesting agent's own access. A successful resolution is also the proof
that the agent may read that Source's cached content.
_Avoid_: ref lookup, access check (as separate concepts)

## Computer form filling

**Vault** — the product's encrypted store of website sign-ins and personal details, which agents
may be granted to fill into forms on a Computer. Its secret values are excluded from model-facing
fill data; a website may still expose them on screen. Every Vault is either a Personal Vault or
the Organization Vault.
_Avoid_: password manager, credential store, keychain. HashiCorp Vault, the CP's optional
encryption backend, is called the **secret cipher**, never "Vault", in product language.

**Personal Vault** — the Vault one member keeps in one organization. Only that member can see or
change it; organization owners cannot.

**Organization Vault** — the one Vault an organization keeps for shared sign-ins and details,
managed by its owners.

**Vault item** — one entry in a Vault: either a Login or a Personal info.
_Avoid_: entry, record, secret (a Vault item holds both secret and non-secret fields)

**Login** — a Vault item that signs in to particular websites: the sites it belongs to, a username,
and the secret values that site asks for.
_Avoid_: credential, account, password (when meaning the whole item)

**Personal info** — a Vault item holding a person's name, contact details and addresses, usable on
any website's form rather than bound to particular sites.
_Avoid_: Identity (already means a linked chat-platform account), profile (browser and user profiles)

**Secret field** — a Vault item field whose value is excluded from model-facing fill data,
messages and logs. A web page may still display it once filled, exposing it through subsequent
screenshots; only a masked input hides it on screen.
_Avoid_: hidden field, sensitive field

**Item grant** — the agents a Vault item may be filled by: selected agents, or, for an Organization
Vault item, all agents. An item granted to no agent is never filled by one, whoever asks.
_Avoid_: share, permission, access (as separate concepts)

**Fill requester** — the person a fill is done for: the sender of the turn's triggering message,
or the session's owner when a turn has no sender. A Personal Vault item fills on its own only for
its owner; anyone else needs the owner's consent.
_Avoid_: caller, user (ambiguous between the requester and the item's owner)

**Fill card** — the card that collects a form's ordinary and secret field values from a person,
so they reach the Computer without passing through the agent's model. Values are used for one
fill unless the person chooses to save them to a Vault they may manage.
_Avoid_: Secret card, password prompt, elicitation (this card's values do not return to the model)
