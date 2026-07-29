# Design: Preset Agents and Guided Onboarding

**Status:** M0 implemented (reserved slugs, nullable `Agent.runtime`, org-creation
seam + one-time backfill + `preset_agent` state, the `agentconnect` general preset,
console tolerance for unplaced agents), together with §5.3 Fulfillment B — the
platform-published "Add to Slack" app (env credentials, state-bound install route,
`Bot.teamId` + composite relay demux, uninstall/revocation lifecycle) — pulled
forward from M4 so the preset agent is Slack-connectable from day one. M1–M2 remain
proposed. **§4 is superseded** and is retained only as reference — see the direction
change below.

**Direction change (2026-07-29) — one preset, no dedicated assistant agent.** There
is exactly one preset agent, `agentconnect` (display name **AgentConnect**), and
there will be no second built-in `agentconnect-assistant`; `PresetAgentKind` carries
only `general`. Assistant/admin capabilities are planned to fold into that one
general preset instead, and the planned first step gives its **webapp
(Playground/webchat) sessions** the AgentConnect MCP admin toolset. The tools
themselves already exist platform-side (agent-assistant.md P0 read tools, P1 write
tools with confirm gates, P2 OAuth AS); the per-session delegated credential
(agent-assistant.md P4's webchat half) remains the security prerequisite before any
admin tool reaches a session, and is not built. §4 records the cancelled
dedicated-assistant shape and is kept as the reference for that fold-in; the reserved
assistant slugs stay reserved (impersonation guard + naming option, §3.3).

**Builds on:** [agent-assistant.md](agent-assistant.md) (its AgentConnect MCP and
embedded OAuth AS are available — external AI tools connect today; its built-in
assistant agent, P3, is cancelled by this design, and its delegated credential, P4,
is still planned), [shared-bot-relay.md](shared-bot-relay.md) (implemented),
[slack-install-smoothing.md](slack-install-smoothing.md) (implemented),
[resource-visibility.md](resource-visibility.md) (implemented).

## 1. Problem

Today the first-run experience is a linear wizard
(`packages/web/src/components/console/views/OnboardingView.tsx`): connect a daemon →
create an agent → set up an integration. After the daemon connects the user still faces
an empty console and a stack of configuration decisions — runtime, agent shape,
integration credentials — before anything talks back.

The target shape:

1. The org is born with one preset agent already in it, unplaced: **`agentconnect`**
   (display name **AgentConnect**), a general-purpose agent — coding, code review,
   everyday tasks — and the deterministic bind target for the platform's Slack and
   GitHub entry points.
2. `agentconnect run` connects the org's first daemon, and the preset is placed
   onto it automatically.
3. The console shows a **Getting-started checklist** derived from real system state.
   Every remaining step deep-links to the console surface that performs it, and the
   same derived state is exposed as an AgentConnect MCP read tool (§6.3) — so an AI
   tool the user has already connected opens from the same truth, and so do the
   general preset's own webapp sessions once the admin toolset lands there (§4).
4. Connecting Slack is one action: hosted deployments offer a platform-published
   **"Add to Slack"**; self-hosted deployments run the existing quick-install funnel
   against a predefined manifest.

Three pieces, each independently useful: preset provisioning (§3), the predefined
Slack app (§5), and the checklist (§6). §4 is the superseded fourth — a dedicated
assistant agent — retained as the reference for folding admin tools into the general
preset.

## 2. Decisions

| Topic                      | Decision                                                                                                                                                                                                                                                                                                                                                                 | Rejected alternatives                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant capabilities     | **No dedicated built-in assistant agent** (2026-07-29). Assistant/admin capabilities fold into the single `agentconnect` general preset; the planned first step is the AgentConnect MCP admin toolset inside its **webapp (Playground/webchat) sessions**. `PresetAgentKind` carries only `general`                                                                      | A second built-in agent — agent-assistant.md's `kind='assistant'` (P3), re-triggered by this design (§4): a separately provisioned identity with admin-tool access costs its own preset row, placement rules, restricted profile, and fixed-property guards for a conversational entry the same toolset can offer from an agent the org already has       |
| Creation & placement       | **Creation at org creation; placement at first daemon.** The preset row is written transactionally with the org itself — unplaced, runtime deferred (§3.2). A CP hook after `register/ok` then auto-places a still-unplaced preset onto the first daemon, one-shot: the first placement of any kind settles it, so a later unplacement by the user is never fought       | Creating at first-daemon-online (an earlier revision): coupling creation to a daemon imported partial-state machinery, made creation wait on runtime readiness, and left the console empty until a daemon appeared. Creation needs no placement target                                                                                                    |
| Credential model           | **Minimal P4 is the prerequisite** before any admin tool reaches a session: delegated-key minting at webchat-token verification, webchat/Playground only. The IM identity-binding half of P4 stays deferred                                                                                                                                                              | A static owner-scoped key, even with owner-locked reachability: an org can have several owners, and a static key authorizes and audits as the key's user rather than the actual initiating owner — breaking the inherited credential-is-identity model and §7's acting-user audit guarantee. Any repair is the minimal delegated minting already required |
| Preset deletion            | The general preset is **freely deletable and never auto-recreated**                                                                                                                                                                                                                                                                                                      | Existence-check provisioning — it resurrects what the user deleted                                                                                                                                                                                                                                                                                        |
| Idempotency                | **Per-preset `preset_agent` row** (`status ∈ {created, skipped}`, `placementSettledAt`), written with the agent row. Creation is transactional with the org (or the one-time backfill) and never retries; auto-placement retries on register events only while the preset is unplaced and unsettled. A deleted preset is never recreated — creation has no later trigger | A single org-level stamp (cannot express per-preset placement); existence-check provisioning (resurrection); creating at daemon time (see the Creation & placement row)                                                                                                                                                                                   |
| Non-empty orgs             | **The preset for every org** — new orgs at creation, existing orgs via a one-time backfill — whatever agents they already have: the general agent must exist deterministically because both Slack fulfillments and the GitHub flow bind to it by default                                                                                                                 | Creating it only for empty orgs — leaves the predefined Slack app without a deterministic bind target, and an org that pre-created agents still benefits from the branded default; creating none at all                                                                                                                                                   |
| Predefined Slack app count | **One** shareable app backing the general agent; dedicated per-agent apps remain the guided upgrade via quick-install                                                                                                                                                                                                                                                    | One app per preset agent; a second app for a separate built-in assistant (§4)                                                                                                                                                                                                                                                                             |

## 3. Preset agents

### 3.1 The preset agent

|                       | `agentconnect`                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display name          | **AgentConnect**                                                                                                                                                            |
| Kind                  | An ordinary agent row — no built-in discriminator ships (§4)                                                                                                                |
| Visibility            | `org`, editable                                                                                                                                                             |
| Runtime               | **Unset at creation** (deferred, §3.2); set at placement from the daemon's reported runtimes, preferring a `ready` one                                                      |
| Profile               | Ordinary agent profile                                                                                                                                                      |
| Workspace             | Scratch; attaching a repository is a checklist step                                                                                                                         |
| MCP                   | Daemon defaults, nothing extra. The planned successor to §4 adds the AgentConnect MCP admin toolset to its **webapp sessions only**, gated on the per-session delegated key |
| Icon                  | Fixed brand glyph + color (stable, recognizable — not the random default)                                                                                                   |
| Persona               | Preset description: general dev agent — code review, coding tasks, everyday questions                                                                                       |
| Integrations at birth | None; it is the default bind target for the predefined Slack app (§5) and the GitHub install flow                                                                           |

### 3.2 Creation, placement, and state

**Creation — at org creation, unplaced.** One transaction, run by the org-creation
service seam (every path — JIT personal orgs, the no-auth default tenant — funnels
through it), writes the agent row and its `preset_agent` record. No daemon, no
capacity, no runtime is needed:

- `Agent.runtime` becomes **nullable** ("deferred exec config", additive migration —
  today it is required and validated against the placing daemon). An agent without a
  runtime is a valid _unplaced_ agent; the invariant moves to placement, which
  requires choosing one. The wire is untouched: `AgentSpec.runtime` is already
  optional, and specs are only assembled for placed agents.
- The preset is created with runtime **unset**.
- Existing orgs receive a **one-time backfill** with identical semantics; a
  reserved-name collision there writes a `skipped` row (§3.3). New orgs cannot
  collide — they have no agents.

**Auto-placement — at first daemon online.** A CP hook after `register/ok`
(`ws/handlers/register.ts`; today's only first-connect behavior is the hostname
name-seed in `daemon.repo.ts`) asynchronously places a still-unplaced preset onto the
daemon, never blocking the handshake:

- **Under the daemon's `maxAgents`.** A daemon already at capacity places nothing;
  the preset stays unplaced and unsettled and is retried on a later register event.
- The preset's **runtime is set now**, from the daemon's reported runtimes —
  preferring one whose probe status (below) is `ready` on the current connection,
  else any reported one.
- Placement deliberately does **not** require readiness: an agent placed on a
  logged-out runtime is an ordinary, supported state — the checklist's probe-status
  item (§6.2) is the user-facing signal, and logging in needs no re-placement.
- **One-shot.** A preset's first placement of any kind — auto or manual — stamps
  `preset_agent.placementSettledAt`. Auto-placement only ever considers a preset with
  `daemonId` null **and** no stamp, so a user who unplaces or moves an agent is never
  fought. An unplaced, unsettled preset retries on later register events (capacity
  freed, another daemon arriving).
- **Settling is not only placement.** An explicit opt-out settles too, atomically
  with the action: deleting the preset stamps `placementSettledAt` on its
  `preset_agent` row, so a delete made before any daemon ever connects is honored —
  the next registration must not place, let alone recreate, what the user removed.
  Status alone cannot carry this: an unplaced agent is `inactive` as well, so the
  stamp is the only signal the hook consults. Contract case:
  delete-before-first-daemon.

**Probe status — for the checklist.** Presence is not signed-in, and the current
facts cannot even express the difference: `FactsRuntimeProfile.authRequired` is
absent both before a probe resolves and after a successful one (the CP stores absence
as `false`, `runtime-profile.repo.ts`), and `modelsSource` is cache-vs-live
provenance, set to `probed` for failed probes too. This design adds an explicit
per-runtime **probe status** to `facts/daemon-runtimes` (additive field, persisted on
the profile row with the observing connection — the channel is seq-fenced):
`pending | ready | auth_required | failed`. Its consumers are the checklist's
"Runtime signed in" item (§6.2) and the runtime preference above; creation and
placement never gate on it. Status may regress — some logged-out runtimes are only
discovered on a live turn, not by the probe — and the derived item simply flips
back. Contract cases: pre-probe (`pending`), a non-auth probe failure (`failed`,
surfaced as runtime trouble rather than "signed in"), every-profile-auth-required
(item incomplete), and ready→logged-out across a reconnect (the item regresses;
nothing else moves).

**State.** `preset_agent (orgId, preset, agentId?, status, placementSettledAt, at)`,
additive migration. `created` = the agent row exists, written in the same
transaction; `skipped` = permanently not created (backfill collision §3.3, or org
opt-out). Deletion needs no tombstone mechanics: creation has no later trigger, so
nothing can resurrect a deleted preset — the row remains as the record the checklist
derives from (§6.2).

**Delivery.** Placement replicates through the ordinary `replicateUpsert` push; the
register-reconcile roster remains the backstop if the daemon is mid-flap.

**Validation parity.** Creation and placement must not bypass what `POST /agents`
enforces (slug rules, capacity, defaults). The route (`http/routes/agents.ts`) is
currently the creation service; extracting its core into a service callable by the
route, the org-creation seam, and the placement hook is part of this work — a raw
repo write is not acceptable.

**Attribution.** The preset stamps `createdByUserId` from the user whose action
created the org (the initial owner; null for the backfill) — it is an ordinary agent
from that moment on, owned and editable like any other. Auto-placement writes an
audit row carrying the daemon and the affected agent.

**Opt-out.** An org-level setting (default on) checked by the creation seam and the
backfill. Self-hosted fleets that want it off globally can set the org default at
deploy time.

### 3.3 Reserved slugs and collisions

Add `RESERVED_AGENT_SLUGS = {'agentconnect', 'agentconnect-assistant', 'agent-assistant',
'assistant'}` validated on `CreateAgentBody`/`UpdateAgentBody`. The existing
`RESERVED_SLUGS` (`http/dto/index.ts`) covers **org** slugs only; agent names have no
protection today, and presets must not be impersonable. This lands **before** any
preset ships.

The assistant-family slugs stay reserved even though no built-in assistant agent
ships (§4): a user-created agent must never be able to wear a platform-sounding
name, and reserving them keeps the naming option open should admin capabilities ever
want an identity of their own. Only `agentconnect` is actually provisioned.

Collisions can only arise in the backfill — a new org has no agents. The org keeps
its agent: the backfill writes a `skipped` state row for that preset and never
renames user resources; validation grandfathers existing rows.

Namespace adjacency, to prevent confusion while implementing:
`RESERVED_MCP_SERVER_NAME = 'agentconnect'` (the daemon's stdio bridge,
`protocol/frames/agent.ts`) is an **MCP-server** name. Agent slugs are a different
namespace; the collision is cosmetic, not structural.

### 3.4 Unplaced agents in the console

The agents list's Daemon column grows a CTA for an unplaced agent: **"Choose
daemon"**, opening a picker of the org's daemons (visibility-filtered), when the org
has any — or **"Add daemon"**, launching the existing join-command flow, when it has
none. When the agent's runtime is unset, the picker bundles the runtime choice from
the selected daemon's reported runtimes — the same pairing the add-agent modal
already implements. The agent detail page carries the same affordance;
runtime/model/effort controls render disabled with a "set when placed" hint until
then. Placing through either surface stamps `placementSettledAt` for a preset
(§3.2). Both form factors follow the console's responsive conventions.

## 4. [SUPERSEDED] The dedicated assistant agent — delta to agent-assistant.md

> **Superseded 2026-07-29. Nothing in §4 is a shipping requirement.** The second
> built-in agent described here — `agentconnect-assistant`, agent-assistant.md's
> `kind='assistant'` (P3) — is cancelled: it is never provisioned, has no preset
> row, no auto-placement, and no `AgentKind` discriminator ships.
>
> **Successor shape.** Assistant/admin capabilities fold into the one `agentconnect`
> general preset (§3.1). The planned first step: the AgentConnect MCP admin toolset
> becomes available inside that agent's **webapp (Playground/webchat) sessions**,
> gated on the same per-session delegated credential this section relies on
> (agent-assistant.md P4, webchat half — still the security prerequisite, still
> unbuilt). This section is retained because that shape reuses the machinery
> described here: session-bound credential minting and binding, a closed and
> auditable tool surface, schema-level confirm-gates, per-initiator session privacy,
> and the onboarding prompt opening.

Would have been reused unchanged from P3/P4: the `AgentKind` discriminator and
partial unique index, fixed-property guards, the restricted runtime profile, the
immutable prompt template, `GET|PUT|DELETE /orgs/:orgId/assistant`, `denyDelegated`
route families, the confirm-gates on destructive MCP tools, and session privacy by
`initiatorUserId`.

Deltas this design would have introduced:

1. **Slug**: `agentconnect-assistant` (§3.3 — still reserved, never provisioned).
2. **Provisioning**: created at org creation (unplaced) and auto-placed at
   first-daemon-online (§3.2), _in addition to_ the owner's `PUT /assistant` for
   move/re-enable, with `DELETE /assistant` (disable) as the owner's opt-out after
   the fact. Auto-placement additionally required a daemon reporting `claude`
   (`RegisterReq.capabilities.runtimes` — a bare id list, no auth information), so a
   codex-only daemon would place the general agent alone and the assistant would
   wait for a claude-capable daemon behind a checklist hint. `DELETE /assistant`
   (which retains the row as `inactive`, v2 §3.2) stamped `placementSettledAt`
   atomically, so a disable made before any daemon ever connected was honored — the
   next registration must not place, let alone re-enable, a disabled assistant.
   Contract case: disable-before-first-daemon.
3. **Prompt**: the immutable template gains an onboarding opening — fetch
   `getOnboardingStatus` (§6.3) at session start, lead with the single most valuable
   incomplete step, propose exactly one next step, act only through tools with their
   existing confirm-gates, and restate destructive operations before running them.
   (Formerly §6.4.)
4. **P4 scope**: only the webchat-token delegated-minting half is required. IM
   identity binding — and with it any Slack presence — stays deferred.

Visibility deliberately matched v2 (`org`, fixed): every member would get the
conversational entry, the Playground would pin the assistant for everyone, and
session privacy by `initiatorUserId` would carry the cross-user isolation.

### 4.1 Superseded decisions (moved out of §2)

| Topic                | Decision (superseded)                                                                                                                                                                                                   | Rejected alternatives                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant identity   | Reuse agent-assistant `kind='assistant'` (P3) wholesale; this design changed only when it is provisioned and its slug                                                                                                   | A parallel "preset assistant" type — two built-ins with admin-tool access doubles the security surface for no product gain                                                                                                                                                                                                                                                       |
| Assistant visibility | `org` — available to every member, fixed per agent-assistant v2; sharing/call-policy writes stay rejected (the lock guards openness), and the row carries no personal creator                                           | `restricted` / private-to-owner (an earlier revision): delegated credentials already make per-message authority exactly the caller's own, so the privacy bought no security and cost every non-owner the conversational entry. If ever revisited: `restricted` admits the **creator**, and collaborators can enroll daemons — a restricted assistant must carry no creator grant |
| Assistant deletion   | Disable, never delete (v2 §3.2 semantics); its `createdByUserId` is **null** (a built-in carries no personal creator) and its mutable surface is the owner-gated `/orgs/:orgId/assistant` endpoints regardless of grant | Generic agent-write routes reaching a built-in — v2's fixed-property guards reject `kind='assistant'` there so conversing is org-wide while configuring stays with owners                                                                                                                                                                                                        |
| Assistant on Slack   | None in v1 — webchat/Playground only                                                                                                                                                                                    | A predefined assistant Slack app: unsafe until Slack-user ↔ AgentConnect-user identity binding exists (P4's deferred half). With only workspace-level identity, anyone in the workspace could borrow the delegated authority                                                                                                                                                     |

### 4.2 Superseded properties (the assistant column of §3.1)

|                       | `agentconnect-assistant`                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                  | `assistant` (P3)                                                                                                                      |
| Visibility            | `org`, fixed; sharing/call-policy writes rejected (v2 guards). Mutable only through the owner-only `/orgs/:orgId/assistant` endpoints |
| Runtime               | `claude`, fixed by the template (v2 §8.2 allowlist); auto-placed only onto a daemon that reports it                                   |
| Profile               | Restricted: no shell/file tools, locked scratch workspace (v2 §8.2)                                                                   |
| Workspace             | Locked scratch                                                                                                                        |
| MCP                   | Exactly one injected server: the CP AgentConnect MCP with a per-session delegated key (P4). No memory/collab/platform tools           |
| Icon                  | Fixed brand glyph + color                                                                                                             |
| Persona               | CP-generated immutable prompt (v2 §8.3) + the onboarding opening above                                                                |
| Integrations at birth | None, ever                                                                                                                            |

### 4.3 Superseded security considerations (moved out of §7)

- **Owner-only mutability**: the assistant would be configured solely through the
  owner-gated `/orgs/:orgId/assistant` endpoints; generic writes targeting
  `kind='assistant'` are rejected, and delegated principals cannot modify the
  assistant through the assistant (agent-assistant.md §6.3) — nobody talks the
  assistant into unlocking itself.
- **Cross-user content isolation**: assistant sessions would be private to their
  `initiatorUserId` (owners keep the governance exemption), and memory tools stay
  removed — agent memory is shared state, so one member's information must not
  surface in another member's conversation (agent-assistant.md v2 decisions).
- **No IM surface** until identity binding exists.
- **Open question, superseded**: widening the assistant runtime allowlist beyond
  `claude` (needs a codex-equivalent restricted profile) — tracked in
  agent-assistant.md.

## 5. Predefined Slack app

### 5.1 Abstraction

A preset agent may declare a **predefined Slack app**: a manifest template — branding
plus the pinned `SLACK_BOT_SCOPES` / `SLACK_BOT_EVENTS`
(`http/slack-manifest.ts`, mirrored in `web/src/lib/slack-manifest.ts`, both pinned by
drift-guard tests). Two fulfillment paths converge on the same end state: a `Bot`
bound to the general preset agent, @-able in the workspace.

### 5.2 Fulfillment A — universal (small delta over shipped machinery)

The checklist's "Connect Slack" runs the existing config-token quick-install funnel
(slack-install-smoothing.md) with the preset manifest — app name from the agent slug,
background color from its icon — and auto-binds the resulting Bot + Integration to the
general preset agent. New work is only: preset manifest defaults, the auto-bind, and
checklist wiring. Token storage, rotation, server-side OAuth, and finalize all exist.

### 5.3 Fulfillment B — hosted platform app (new machinery)

The true "just click Install" path: a platform-published, distributable Slack app
installed via standard OAuth v2. Verified gaps against current code:

- **Platform credentials.** No platform-level Slack credentials exist (`config/env.ts`
  has the `GITHUB_APP_*` precedent but no `SLACK_*`). Add
  `SLACK_PLATFORM_CLIENT_ID/_CLIENT_SECRET/_SIGNING_SECRET/_APP_ID`; unset ⇒ the
  feature is absent (self-hosted default). Values live only in deployment config.
- **Install starts from the console.** The OAuth callback strictly requires a `state`
  resolving to a pending-install row (`routes/slack-install.ts` renders denied/expired
  otherwise), and a bare share URL cannot carry org/agent tenancy. A new route mints
  `state` binding `{orgId, targetAgentId, userId}` and redirects to the authorize URL;
  any public landing page can only bounce the user back into their console.
- **Callback branch.** Exchange with the platform credentials and **persist `team.id`
  and `bot_user_id`** — today `SlackOAuthResult` deliberately drops `team.id`
  (`http/slack-config-api.ts`).
- **Schema.** `Bot.teamId` (nullable for legacy rows) + unique `(slackAppId, teamId)`;
  multiple `Bot` rows may now share one `slackAppId` across orgs.
- **Relay demux.** Today demux is a learned `api_app_id → botId` map with a
  signing-secret brute scan as fallback (`relay/src/shared-bot-manager.ts`). Every
  install of a distributed app shares both the app id **and** the signing secret, so a
  composite `(api_app_id, team_id)` key is a correctness requirement, not an
  optimization. `teamId` is already plumbed into `resolveVerified` and currently
  unused.
- **Install lifecycle.** Handle `app_uninstalled` and `tokens_revoked` (mark the Bot
  revoked, surface in the console). Token rotation stays off, matching existing
  manifests.
- **Transport.** Distributed apps are Events-API-only — a socket-mode app token is
  per-app and cannot be demuxed per workspace — so this path hard-depends on the relay
  pool (`PUBLIC_RELAY_URL` + ≥1 connected relay), exactly like `http` transport today.

### 5.4 The scope contract

Public distribution freezes the scope list: widening it later forces every installed
workspace to re-authorize. The pinned lists (currently 17 bot scopes including
`mpim:history`/`mpim:read`/`im:write`/`commands`, and events including `message.mpim`)
are the launch contract, enforced by the cross-package drift guards. Any future
widening is a product event — a coordinated re-auth — not a routine PR.

### 5.5 One app, shareable

The platform app backs the general preset agent as the default owner of a **shareable**
bot (`Bot.shareable`); additional agents can ride the same bot later via channel
ownership and mention arbitration (shared-bot-relay.md). Dedicated per-agent Slack
identities remain the upgrade path through quick-install, surfaced by the console's
integration flow.

## 6. Onboarding checklist

### 6.1 Wizard reduction

The full-screen wizard shrinks to its only blocking step: connect a daemon (join
command + wait-for-online). `needsOnboarding()`
(`web/src/lib/onboarding.ts`) is reworked: preset agents no longer count toward
`agentCount`, and the full-screen gate keys on "no daemon has ever connected". After
that, onboarding is a persistent, collapsible **Getting started** card on the Agents
view — non-blocking, dismissible, reopenable from Help.

### 6.2 Derived state, not stored ticks

Every item derives from live resources; nothing stores "step done". The only persisted
bit is a per-user dismissal.

| Item                           | Derivation                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon connected               | daemon status `ready`                                                                                                                                                                    |
| Runtime signed in              | at least one **ready** runtime (§3.2, latest stored probe status) — non-empty profiles are not enough: they include installed-but-logged-out (`auth_required`) and failed-probe runtimes |
| Meet your agent                | the preset is placement-settled — `placementSettledAt` stamped, `skipped`, or the preset deleted (§3.2)                                                                                  |
| Connect Slack                  | a Slack integration exists                                                                                                                                                               |
| Connect GitHub                 | a GitHub App installation exists                                                                                                                                                         |
| Give your agent a repository   | general agent's workspace ≠ scratch                                                                                                                                                      |
| Finish your first conversation | a completed session exists                                                                                                                                                               |
| Invite teammates               | org member count > 1                                                                                                                                                                     |

### 6.3 One state, two consumers

A single BFF endpoint — `GET /orgs/:orgId/onboarding` → items with status — consumed
by (a) the console checklist and (b) a new AgentConnect MCP **read** tool,
`getOnboardingStatus`, so an AI tool the user has already connected
(agent-assistant.md §6) reads the same truth and proposes the actual next step — and
so do the general preset's own webapp sessions once the admin toolset lands there
(§4). Each todo item carries a console deep link. The two surfaces can never disagree
because neither owns the state.

## 7. Security considerations

- **Confused deputy / actor identity**: per-session delegated credentials are a
  prerequisite, not an option, before any admin tool reaches a session — they are the
  entire guarantee: each tool call executes through the REST layer as the initiating
  user, so RBAC and visibility are evaluated live per message and a member can never
  do through an agent's admin tools what they could not do in the console. Roles
  resolve live, so a demotion applies immediately. Any static key would authorize and
  audit as its key user rather than the actual actor.
- **Provisioning parity**: the preset is created through the same validation core as
  `POST /agents` (§3.2), never a raw repo write.
- **Reserved slugs** prevent impersonating built-ins (§3.3), including the
  assistant-family names that are reserved but never provisioned.
- **Auditability**, per path: org-creation provisioning records the creating user
  as actor; the backfill records a system actor (no user performed it);
  auto-placement records a system actor with the daemon and affected agent
  (§3.2); manual placement records the placing user. Every MCP write logs through
  the operation log with the acting user's identity (agent-assistant.md §9.3).
- The security properties the superseded assistant agent would have carried — its
  owner-only mutability, per-initiator session isolation, and the absence of any IM
  surface — are recorded in §4.3.

## 8. Phasing

| Phase                  | Contents                                                                                                                                                                                                                                                                                                                               | Depends on                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| M0                     | Auto-creation, **no new UI**: `RESERVED_AGENT_SLUGS`; nullable `Agent.runtime`; org-creation seam + one-time backfill + `preset_agent` state; the general preset created for new orgs and backfilled orgs. The console only needs to tolerate an unplaced, runtime-less agent (render "—"; existing edit/placement paths keep working) | Nothing new                   |
| M1                     | Auto-placement at first daemon online + the probe-status facts field — still CP-side only                                                                                                                                                                                                                                              | M0                            |
| M2                     | Console UX: Choose/Add-daemon CTA (§3.4); checklist + `/onboarding` endpoint + `needsOnboarding` rework; Fulfillment A auto-bind                                                                                                                                                                                                       | M0 (M1 for placement states)  |
| M3 (planned successor) | Admin tools inside the general preset's **webapp (Playground/webchat) sessions**: minimal P4 (per-session delegated key) first as the security prerequisite, then the AgentConnect MCP admin toolset scoped to those sessions, plus the `getOnboardingStatus` read tool (§6.3). Replaces the cancelled dedicated assistant preset (§4) | M0–M2; agent-assistant.md P4  |
| M4 (hosted)            | Distributed Slack app: platform env creds, install route + state, `teamId` schema + composite relay demux, uninstall/revoke lifecycle. **Pulled forward and implemented in M0** (§5.3)                                                                                                                                                 | Independent of M3; relay pool |
| M5                     | Guided per-agent Slack app upgrades. Any admin surface outside webapp sessions additionally needs the IM identity-binding half of agent-assistant.md P4; the superseded assistant's Slack DMs are cancelled with §4                                                                                                                    | M3, M4                        |

## 9. Open questions

- Whether provisioning should also seed a starter cron or memory note (leaning no —
  the checklist covers discovery).
- The exact opt-out surface for self-hosted fleets (org setting vs deploy-time env
  default).
- How far the successor shape (§4) scopes the admin toolset inside a general-purpose
  agent's webapp sessions — the general preset is an ordinary, shell-capable agent,
  so the restricted-profile reasoning of §4.2 does not transfer unchanged.
