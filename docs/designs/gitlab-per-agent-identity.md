# GitLab Per-Agent Runtime Identity

> Status: **Proposed** — supersedes Section 7.2 of
> [gitlab-com-integration.md](gitlab-com-integration.md) on acceptance. The
> rest of that design (webhooks, credentials purposes, output ownership,
> reviews, projection) is amended only where this document says so.

## 1. Decision Summary

The GitLab runtime identity moves from **one service account per project** to
**one service account per agent per top-level group**. Each agent gets its own
GitLab face: the account's display name is the agent's name, every note,
review, and push in a project the agent works on is authored by that agent's
own account, and "request review from the bot" means a specific agent.

The per-project account shipped in v1 solved the problem it was designed for —
a non-human author with project-scoped cleanup — but it makes every agent on a
project speak through the same mouth. Agents are the product's personas: on
Slack, Telegram, and Discord each agent is its own bot identity, and the pilot
feedback was immediate — a thread answered by `test-private-bot` reads as
infrastructure, while a thread answered by `review-bot` reads as the agent the
user configured. Attribution today lives only in a footer.

A second, structural payoff: GitLab's review bulk-publish operates on **all
pending drafts of the authenticated user** on a merge request. With one shared
account, two agents reviewing the same MR could consume each other's drafts,
which is why Section 15.1's publication lease exists as a hard correctness
boundary across agents. With per-agent accounts, that cross-agent hazard
disappears at the provider; the lease survives only to serialize one agent's
own replays.

### Why "per top-level group"

GitLab group service accounts "can be invited to the group where they were
created or to any descendant subgroups or projects" — membership cannot cross
the top-level group boundary. An agent whose authorized projects span two
top-level groups therefore needs one account in each. In the common case
(every project under one root) this is exactly one account per agent; the
model is honest about the general case rather than pretending the provider
allows a single global account.

## 2. Goals

- Every GitLab contribution an agent makes is authored by an account whose
  display name is that agent's name.
- Two agents on one project act as two visibly distinct GitLab users.
- `REQUEST_CHANGES` reviewer assignment and approvals name a specific agent.
- Existing deployments migrate without a flag day: the per-project account
  keeps serving a project until every consumer on it has moved.

## 3. Non-Goals

- Bot-to-bot triggering on GitLab (one agent's note waking another) stays
  off in this revision; the loop-prevention veto widens to cover sibling
  agents' accounts. Opening it deliberately later mirrors the chat-platform
  bot-to-bot decision and gets its own change.
- No change to webhooks, signing keys, or the deployment-global project
  claim — those are project-shaped and stay per-project.
- No change to the OAuth administration identity (Section 7.1) or to which
  human authority provisions accounts.
- Self-managed instances are out of scope while that proposal is shelved;
  where quotas are cited, only the GitLab.com numbers are normative here.

## 4. Identity Model

### 4.1 Account shape

One group service account per **(organization, agent, top-level group)**:

- **Username** — `agentconnect-a<agentIdHex>-g<rootGroupId>`, where
  `agentIdHex` is the agent's UUID without dashes and `rootGroupId` is the
  numeric id of the top-level group the account lives in. Deterministic from
  its key, globally unique across deployments (the UUID carries the entropy,
  the root id disambiguates the same agent's accounts), and rename-stable:
  agent renames never touch it.
- **Display name** — the agent's display name (or name), sanitized exactly as
  the current `<project>-bot` derivation sanitizes, without any suffix:
  an agent named `review-bot` appears as `review-bot`. On agent rename, the
  next provisioning convergence PATCHes the display name under the mutation
  lease; a refused rename is cosmetic and never degrades credentials, matching
  the shipped backfill behavior.
- Same non-human properties as today: no UI sign-in, no licensed seat,
  Developer role by default, all project policy (branch rules, approval
  eligibility, author/committer restrictions) still applies and is never
  bypassed by raising the role.

### 4.2 Membership

Account membership follows the agent's authorization, not the account's
existence:

- Binding a project to an agent (workspace or hook) ensures the agent's
  account exists in that project's top-level group, then adds it as a project
  member with the role derived from the workspace `gitAccess` clamp.
- Removing the agent's last consumer on a project removes the membership.
- Deleting the agent retires all of its accounts (Section 8).

The **project binding** remains the per-project resource it is today — it owns
the webhook, the signing key, the desired-events union, and the
deployment-global claim. What leaves the binding is the identity: the
`serviceAccountUserId` / `serviceAccountUsername` columns stop being the
binding's and become rows of a new per-agent account table, with a membership
join recording (account, project, role, state).

### 4.3 New persistence

- `gitlab_agent_account` — org, agent, root group id, numeric user id,
  username, display-name fingerprint, credential epoch, state
  (`provisioning | ready | admin_degraded | cleanup_pending`), state reason.
  Lifecycle states and their transitions reuse the binding vocabulary and the
  same console translations.
- `gitlab_account_membership` — account, project (binding), role, state.
  Provider-truth discipline: convergence lists actual project members before
  trusting local rows, exactly as webhook convergence does today.

PAT purposes (`read`, `git_write`, `effect`) are unchanged in meaning but are
minted against the agent's account. The daemon already requests credentials
per agent; the control-plane resolution loses the "which project's account"
indirection and gains "which root's account for this project" — a lookup by
(agent, project→root).

## 5. Where the Identity Is Consumed

- **Git and glab (Section 13)** — the helper serves the agent's own read /
  git-write PATs. `useHttpPath=true` and all echo verification carry over; the
  grant's `username` field now names the agent account.
- **Final poster, broker, projection (Sections 14, 16)** — effect leases mint
  against the agent account; notes and broker mutations are authored by it.
  Projection status notes become per-agent: when several agents watch one
  merge request, each maintains its own note per head. This is deliberate —
  one shared note cannot attribute N runs, and the clutter is bounded by the
  number of agents a maintainer chose to point at the project. The hidden
  marker already contains the projection key, which becomes per-hook (and
  hooks are per-agent), so reconciliation is unchanged.
- **Formal reviews (Section 15)** — drafts, bulk publish, reviewer state, and
  approvals all act as the agent's account. `REQUEST_CHANGES` requires _that
  agent's_ account to be a current reviewer; the console copy and the design's
  reviewer-assignment guidance become per-agent ("request review from
  review-bot").

### 5.1 Section 15.1 rewritten: what the lease still guards

The publication lease table is already keyed
`(provider, projectExternalId, mergeRequestIid, serviceAccountExternalId)`;
with per-agent accounts the last component differs per agent, so two agents
reviewing the same MR hold independent leases and GitLab's per-user bulk
publish can no longer consume a sibling's drafts. What remains, unchanged:

- one attempt per turn, CAS acquisition, the monotonic fence;
- single-use operation records with the one-outbound-request invariant —
  these guard **crash replay of the same agent**, not sharing;
- marker-based reconciliation and `ambiguous_locked` with no timeout escape.

What disappears: cross-agent `lease_held` contention as a normal event, and
the "shared account is a correctness boundary" rationale. The prose of
Section 15.1 is updated on acceptance to attribute the lease to same-agent
replay serialization.

### 5.2 Loop prevention (Section 12.1) — the one widened veto

Today the compiled relay rule vetoes events authored by the project's single
account. Per-agent accounts would otherwise let agent A's note trigger agent
B — accidental bot-to-bot. The compiled rule for a project therefore carries
the set of **all agent-account user ids currently bound to that project**, and
the relay vetoes an event whose author is any of them. The field is additive
and optional on the wire; an old relay keeps vetoing only the id its rule
already names, which stays correct throughout migration because agents keep
posting through the project account until the daemon-side switch (Section 9)
is enabled — the ordering requirement is that the widened veto ships **before**
any per-agent account posts.

## 6. Console

- The agent detail page owns the agent's GitLab identity: a bot chip
  (`@agentconnect-a…`, display name, profile link) plus its account health,
  reusing the binding-state translations.
- The Integrations card's project rows keep webhook/claim health and Repair /
  Remove / Transfer; the bot chip on a project row becomes the list of agent
  accounts that are members, each linking to its profile.
- No new required input: names derive from agents. (A per-agent display-name
  override is a possible later nicety, deliberately not part of this change.)

## 7. Quotas and Refusal

GitLab.com allows **100 service accounts per top-level group** (subgroup and
project accounts included). Under this model the count is agents-with-projects
in that root, plus transitional project accounts during migration. When
creation is refused, the account row lands `provisioning`-failed with a
`service_account_quota` reason, the console translates it actionably, and the
agent's existing credentials (if any) are untouched. The transitional overlap
is bounded: migration retires one project account for every project fully
moved (Section 9).

## 8. Lifecycle, Cleanup, Transfer (Section 19 amendments)

- **Agent deletion** retires every account of that agent: revoke PATs, delete
  the account, remove local rows — the same verified-external-cleanup
  discipline as binding removal, per root group. Lost administration
  authority degrades to `cleanup_pending` with the same reconnect-or-transfer
  exits the binding cleanup has today.
- **Project unbind** removes memberships only; accounts persist while the
  agent has any other project in that root, else the account is retired too
  (empty accounts are not kept warm).
- **Transfer** (the takeover route) applies unchanged to bindings; account
  rows gain the same installer-authority association and the same takeover
  eligibility when their administering connection is gone.
- **Rotation (Section 7.4)** mechanics are unchanged; the population being
  rotated is per-agent accounts, so rotation fan-out scales with agents
  rather than projects.

## 9. Migration

No flag day. Real per-project accounts exist in deployments; they keep
working until each project has fully moved.

1. **Veto widening first** (relay + wire, additive): rules carry the veto id
   set; old relays unaffected.
2. **Account lifecycle in the control plane**: the new tables, per-agent
   account creation on the next provisioning convergence of any binding an
   agent consumes, membership convergence, display-name sync. Credentials
   begin minting from the agent account as soon as it is `ready`; until then
   the project account serves, decided per grant at mint time — the daemon
   sees only a grant whose username it echoes back, so no daemon change is
   needed for credentials.
3. **Author switch in the daemon**, gated by a `gitlab-agent-identity-v1`
   feature the control plane advertises only when the agent's account is the
   credential source: poster, broker, review adapter, and projection write as
   the agent account. The trusted hook metadata already carries the account
   identity per rule, so the daemon never derives it.
4. **Retirement**: when every consumer of a project mints from agent
   accounts, the next convergence retires the project account through the
   existing removal saga. A retired-but-stuck project account is repairable /
   transferable exactly like today.

Rolling-compat notes (Section 17.3 discipline): the rule's veto set and the
account fields on trusted metadata are additive optional members; nothing is
removed from any frame until the retirement milestone is complete everywhere.

## 10. What Gets Worse

- **More accounts**: rotation, membership convergence, and cleanup fan out
  per agent; a busy root group approaches the 100-account ceiling sooner
  (mitigated by retiring empty accounts and by the ceiling counting agents,
  which organizations grow more slowly than projects).
- **N status notes** on a merge request watched by N agents.
- **Migration carries a transitional double population** of accounts per
  project until retirement completes.
- **Multi-root agents** hold several accounts; the console must present that
  without confusing users (the agent page groups them by root).
- The reviewer-assignment story becomes per-agent, so a human must request
  review from the right bot when several are present.

## 11. Implementation Plan

Each slice is one PR; control-plane and daemon land separately where rolling
compatibility demands.

- **A1 — veto set** (protocol + relay + CP rule projection): additive veto id
  list, relay veto widened, tests for old-rule tolerance.
- **A2 — account lifecycle** (CP): tables, provisioner account/membership
  convergence, display-name sync, quota refusal, credential source selection
  at mint time, console account health on the agent page.
- **A3 — author switch** (daemon): `gitlab-agent-identity-v1` gate; poster,
  broker, review adapter, projection author as the agent account; per-agent
  lease behavior asserted (two agents review one MR concurrently with no
  cross-contention).
- **A4 — retirement + console polish**: project-account retirement in
  convergence, Integrations card member list, migration telemetry, docs.

Exit criteria: the Section 23 review matrix rerun with two agents on one
merge request; a live pilot where two agents answer the same issue as two
distinct authors; migration verified on a deployment that started with
per-project accounts.
