# Design: Org-Scope Knowledge from Dreaming

> Status: Proposal (not implemented). Options paper — §5 recommends one.
> Prerequisites: [memory-dreaming.md](memory-dreaming.md),
> [memory-evolution.md](memory-evolution.md) (M-6 shared scope),
> [daemon-centric-architecture.md](daemon-centric-architecture.md),
> [agents-collaboration-design.md](agents-collaboration-design.md)
> Keywords: org memory, shared scope, cross-agent, curator, peer interview,
> provenance, visibility

---

## 1. The ask

Memory today is **per agent**: one managed store at `<agent-root>/memory/`, on
one daemon, mined by that agent's own dreams. The question this doc answers:
_can an agent dream across historic sessions and coordinate with other agents to
produce knowledge useful to the whole organization?_

Two things already point this way and are worth knowing before choosing a design:

- `MemoryScopeKind` in the protocol already enumerates
  `'agent' | 'user' | 'session' | 'shared'` — the shared scope is reserved, not
  invented here.
- `memory-evolution.md` lists **M-6 · shared scope (through data plane)** as a
  planned milestone, noting it depends on the relay, a `memory-sync` payload,
  and "shared-scope sync + conflict semantics."

So the destination exists on paper. What is missing is a **producer** (dreaming
is the natural one) and answers to the hard questions M-6 defers.

## 2. Constraints that decide the design

These are not preferences; each one eliminates otherwise-obvious options.

**C1 — Body-locality.** The Control Plane stores control metadata only: never
message bodies, never memory content. An "org memory table in Postgres" is
therefore not available. Org knowledge must live on a daemon (or behind an
external memory plugin), with the CP brokering bounded proxied reads — the same
shape the console already uses for `memory/list` + `memory/read`.

**C2 — Agents are spread across daemons.** There is no shared filesystem. Any
cross-agent access is a network hop through the CP or the relay data plane.

**C3 — Visibility is per-agent and asymmetric.** Agents carry
`visibility: 'org' | 'restricted'` plus `sharedWith`, enforced by `canView` /
`canEdit`. Knowledge mined from a _restricted_ agent and pooled into a store
everyone reads is a **privilege-escalation channel**. This is the constraint
most likely to be overlooked and most expensive to retrofit.

**C4 — The injection surface widens.** Today a poisoned transcript can corrupt
only its own agent's memory, and the staged-review invariant contains it. Org
knowledge read by _many_ agents means a prompt injection in agent A's transcript
can attempt to steer agent B. Review authority must therefore be at least as
strong as the union of contributors, not the weakest one.

**C5 — Cost is multiplicative.** A dream is already a large model pass. Anything
that fans out across N agents multiplies that. Whatever ships must be
schedulable and bounded, not per-turn.

## 3. Three designs

|                           | Gathering                                                       | Storage                            | Reuses                                               | Cost   |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- | ------ |
| **A. Curator pull**       | Curator dream reads contributors' **memory files** via CP proxy | Curator agent's own managed store  | Dreaming, staging, review, adoption, capability gate | Low    |
| **B. Shared scope (M-6)** | Contributors **write** a shared store over the relay            | Dedicated store with a home daemon | Relay data plane                                     | High   |
| **C. Peer interview**     | Curator **asks** peers; each answers from its own memory        | Curator's store                    | Collaboration surface + dreaming                     | Medium |

### A. Curator pull

Designate one agent the org curator. Its dream is granted read access to a
declared **contributor set**; it pulls each contributor's memory index and topic
files through the CP's existing bounded proxy reads, consolidates, and stages
into its own store. Review and adoption are unchanged.

- **For:** almost no new machinery. Body-locality holds (C1) because the CP
  proxies without persisting. One milestone.
- **Against:** it is one-directional — the org store is just one agent's memory,
  and nothing makes other agents _read_ it. Also requires a new cross-agent read
  authority in the CP, which is exactly where C3 bites.

### B. Shared scope (M-6 proper)

A real `scope: 'shared'` store with a designated **home daemon**. Contributors
write to it over the relay data plane; readers read the same way.

- **For:** the honest destination. Other agents can have the org index injected
  at session start. Matches the reserved `MemoryScopeKind`.
- **Against:** ownership, fencing, and conflict resolution across daemons — the
  hard problems M-6 already flags. Multi-writer conflict semantics on a
  Markdown store are their own design.

### C. Peer interview

The org dream never reads peers' memory. It **asks** them over the existing
agent-collaboration channel — "what have you learned about X?" — and each peer
answers _from its own memory, in its own words_. The curator consolidates the
answers.

- **For:** the strongest privacy story. No raw memory or transcript ever crosses
  an agent boundary; each agent is the gatekeeper of what it shares, which
  respects C3 structurally rather than by policy. Per-agent secrets, repos, and
  channel context stay put. It is also how humans do it — a retro, not a
  database join.
- **Against:** N model calls (C5), lossy and non-deterministic answers, and it
  needs a peer-availability story (an offline agent simply doesn't answer).

## 4. Four decisions that must be made regardless

1. **Provenance per entry.** Every org memory line records which agents
   contributed it. Without this, org memory cannot be **revoked** when an agent
   is removed or restricted, and a reviewer cannot tell where a claim came from.
   Retrofitting provenance after entries exist is effectively impossible.
2. **Visibility floor.** Simplest safe rule: only `visibility: 'org'` agents may
   contribute. A restricted agent's knowledge never enters a store with a wider
   audience than the agent itself. Anything more permissive needs an explicit
   intersection model.
3. **Review authority.** Org adoption must not be gated more weakly than the
   _most_ tightly held contributor. Edit rights on the curator alone is not
   sufficient.
4. **Injection budget.** The org index competes with the agent's own index for
   the ~25 KB prompt cap. It needs its own smaller, separate cap — sharing one
   silently starves whichever loads second.

## 5. Recommendation — phased, C then A, with B as destination

**O-1 · Curator dream with peer-interview gathering.** Add an org-dream mode to
the existing `DreamRunner`: a curator agent, a declared contributor set,
gathering by asking peers over the collaboration surface, output staged into the
curator's own managed store. **No new storage primitives** — this is the dream
pipeline that already exists with a different gather phase, so it inherits
staging, the adoption fence, the review model, and the capability gate for free.

**O-2 · Distribution.** Subscribing agents get the org **index** injected at
session start, read-only, served from the curator's daemon through the CP proxy.
This is the step that turns a curated store into org knowledge.

**O-3 · True shared scope (M-6).** Promote only if write-from-many becomes a
real requirement. Not before — the conflict semantics are a milestone of their
own and O-1/O-2 do not require them.

Why this order: C gives the privacy properties C3 demands _structurally_, A
gives storage with no new primitives, and B is deferred until something actually
needs it. Each step is independently useful and independently reviewable.

## 6. What changes in code (O-1 sketch)

- **protocol** — an org-dream variant of the dreaming policy: curator flag,
  contributor set, and an `orgDream` trigger. `DreamInfo` gains contributor ids
  so provenance is present from the first entry (decision 1).
- **daemon** — a gather phase that issues peer questions over the collaboration
  routes instead of reading transcripts, with a bounded answer budget; the rest
  of `DreamRunner` is unchanged.
- **control-plane** — authorize the curator↔contributor relationship against the
  visibility rules (decision 2) and relay the peer questions; still stores no
  content.
- **web** — the org dream surfaces in the curator's dream history with
  contributor attribution per entry.

## 7. Explicitly out of scope

- Cross-**org** knowledge. Nothing here crosses an org boundary.
- Automatic org-memory writes without review. Org adoption is human-reviewed for
  the same reason mined skills are: a wider blast radius, not a smaller one.
- Making org memory writable by contributors (that is B).
- Vector or semantic retrieval over org memory — orthogonal, see M-7.
