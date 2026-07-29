# Design: Preset Agents and Guided Onboarding

**Status:** Proposed (not implemented).

**Builds on:** [agent-assistant.md](agent-assistant.md) (AgentConnect MCP + OAuth shipped;
the built-in assistant P3 and delegated credentials P4 are pending — this design changes
_when_ that assistant is provisioned, not _what_ it is),
[shared-bot-relay.md](shared-bot-relay.md) (implemented),
[slack-install-smoothing.md](slack-install-smoothing.md) (implemented),
[resource-visibility.md](resource-visibility.md) (implemented).

## 1. Problem

Today the first-run experience is a linear wizard
(`packages/web/src/components/console/views/OnboardingView.tsx`): connect a daemon →
create an agent → set up an integration. After the daemon connects the user still faces
an empty console and a stack of configuration decisions — runtime, agent shape,
integration credentials — before anything talks back.

The target shape:

1. The org is born with two preset agents already in it, unplaced:
   **`agentconnect-assistant`**, a built-in setup/operations assistant wired to the
   AgentConnect MCP and available to every member, and **`agentconnect`**, a
   general-purpose agent (coding, code review, everyday tasks).
2. `agentconnect run` connects the org's first daemon, and the presets are placed
   onto it automatically.
3. The console shows a **Getting-started checklist** derived from real system state.
   Every remaining step has two paths: click through the console, or ask the assistant
   to do it conversationally — it drives the same control-plane operations
   through the MCP write tools.
4. Connecting Slack is one action: hosted deployments offer a platform-published
   **"Add to Slack"**; self-hosted deployments run the existing quick-install funnel
   against a predefined manifest.

Four pieces, each independently useful: preset provisioning (§3), the assistant as a
re-triggered agent-assistant (§4), the predefined Slack app (§5), and the checklist
(§6).

## 2. Decisions

| Topic                      | Decision                                                                                                                                                                                                                                                                                                                                                                        | Rejected alternatives                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant identity         | Reuse agent-assistant `kind='assistant'` (P3) wholesale; this design only changes when it is provisioned and its slug                                                                                                                                                                                                                                                           | A parallel "preset assistant" type — two built-ins with admin-tool access doubles the security surface for no product gain                                                                                                                                                                                                                                                                                                                                                               |
| Creation & placement       | **Creation at org creation; placement at first daemon.** Both preset rows are written transactionally with the org itself — unplaced, runtime deferred (§3.2). A CP hook after `register/ok` then auto-places still-unplaced presets onto the first daemon, one-shot per preset: the first placement of any kind settles it, so a later unplacement by the user is never fought | Creating at first-daemon-online (an earlier revision): coupling creation to a daemon imported partial-state machinery — a one-slot or codex-only daemon creates only one preset — made creation wait on runtime readiness, and left the console empty until a daemon appeared. agent-assistant v2's org-creation objection ("no placement target") conflated creation with placement — creation needs none. Owner-manual-only (v2 status quo) remains as the disable/move/re-enable path |
| Assistant visibility       | `org` — available to every member, fixed per agent-assistant v2; sharing/call-policy writes stay rejected (the lock guards openness), and the row carries no personal creator (§3.2)                                                                                                                                                                                            | `restricted` / private-to-owner (an earlier revision of this design): delegated credentials already make per-message authority exactly the caller's own, so the privacy bought no security and cost every non-owner the conversational entry. If ever revisited: `restricted` admits the **creator**, and collaborators can enroll daemons — a restricted assistant must carry no creator grant                                                                                          |
| Credential model           | **Minimal P4 is a prerequisite**: delegated-key minting at webchat-token verification, webchat/Playground only. The IM identity-binding half of P4 stays deferred                                                                                                                                                                                                               | A static owner-scoped key, even with owner-locked reachability: an org can have several owners, and a static key authorizes and audits as the key's user rather than the actual initiating owner — breaking the inherited credential-is-identity model and §7's acting-user audit guarantee. Any repair (a request/session-bound, non-substitutable actor credential) is the minimal delegated minting already required                                                                  |
| Preset deletion            | Assistant: disable, never delete (v2 §3.2 semantics). General agent: freely deletable and **never auto-recreated**                                                                                                                                                                                                                                                              | Existence-check provisioning — it resurrects what the user deleted                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Idempotency                | **Per-preset `preset_agent` row** (`status ∈ {created, skipped}`, `placementSettledAt`), written with the agent row. Creation is transactional with the org (or the one-time backfill) and never retries; auto-placement retries on register events only while a preset is unplaced and unsettled. A deleted preset is never recreated — creation has no later trigger          | A single org-level stamp (cannot express per-preset placement); existence-check provisioning (resurrection); creating at daemon time (see the Creation & placement row)                                                                                                                                                                                                                                                                                                                  |
| Non-empty orgs             | **Both presets for every org** — new orgs at creation, existing orgs via a one-time backfill — whatever agents they already have: the assistant is a platform capability, and the general agent must exist deterministically because both Slack fulfillments and the GitHub flow bind to it by default                                                                          | Creating the general agent only for empty orgs — leaves the predefined Slack app without a deterministic bind target, and an org that pre-created agents still benefits from the branded default; creating neither                                                                                                                                                                                                                                                                       |
| Assistant on Slack         | None in v1 — webchat/Playground only                                                                                                                                                                                                                                                                                                                                            | A predefined assistant Slack app now: unsafe until Slack-user ↔ AgentConnect-user identity binding exists (P4's deferred half). With only workspace-level identity, anyone in the workspace could borrow the delegated authority                                                                                                                                                                                                                                                         |
| Predefined Slack app count | **One** shareable app backing the general agent; dedicated per-agent apps remain the guided upgrade via quick-install                                                                                                                                                                                                                                                           | Two apps (assistant app deferred, above); one app per preset agent                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 3. Preset agents

### 3.1 The two agents

|                       | `agentconnect-assistant`                                                                                                              | `agentconnect`                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Kind                  | `assistant` (P3)                                                                                                                      | `standard`                                                                                                             |
| Visibility            | `org`, fixed; sharing/call-policy writes rejected (v2 guards). Mutable only through the owner-only `/orgs/:orgId/assistant` endpoints | `org`, editable                                                                                                        |
| Runtime               | `claude`, fixed by the template (v2 §8.2 allowlist); auto-placed only onto a daemon that reports it                                   | **Unset at creation** (deferred, §3.2); set at placement from the daemon's reported runtimes, preferring a `ready` one |
| Profile               | Restricted: no shell/file tools, locked scratch workspace (v2 §8.2)                                                                   | Ordinary agent profile                                                                                                 |
| Workspace             | Locked scratch                                                                                                                        | Scratch; attaching a repository is a checklist step                                                                    |
| MCP                   | Exactly one injected server: the CP AgentConnect MCP with a per-session delegated key (P4). No memory/collab/platform tools           | Daemon defaults, nothing extra                                                                                         |
| Icon                  | Fixed brand glyph + color (stable, recognizable — not the random default)                                                             | Fixed brand glyph + color                                                                                              |
| Persona               | CP-generated immutable prompt (v2 §8.3) + onboarding opening (§6.4)                                                                   | Preset description: general dev agent — code review, coding tasks, everyday questions                                  |
| Integrations at birth | None, ever (v1)                                                                                                                       | None; it is the default bind target for the predefined Slack app (§5) and the GitHub install flow                      |

### 3.2 Creation, placement, and state

**Creation — at org creation, unplaced.** One transaction, run by the org-creation
service seam (every path — JIT personal orgs, the no-auth default tenant — funnels
through it), writes both agent rows and their `preset_agent` records. No daemon, no
capacity, no runtime is needed:

- `Agent.runtime` becomes **nullable** ("deferred exec config", additive migration —
  today it is required and validated against the placing daemon). An agent without a
  runtime is a valid _unplaced_ agent; the invariant moves to placement, which
  requires choosing one. The wire is untouched: `AgentSpec.runtime` is already
  optional, and specs are only assembled for placed agents.
- The general preset is created with runtime **unset**; the assistant preset carries
  `claude`, fixed by its template rather than guessed.
- Existing orgs receive a **one-time backfill** with identical semantics; a
  reserved-name collision there writes a `skipped` row (§3.3). New orgs cannot
  collide — they have no agents yet.

**Auto-placement — at first daemon online.** A CP hook after `register/ok`
(`ws/handlers/register.ts`; today's only first-connect behavior is the hostname
name-seed in `daemon.repo.ts`) asynchronously places still-unplaced presets onto the
daemon, never blocking the handshake:

- **Assistant first** under the daemon's `maxAgents`; the assistant is placed only when
  the daemon reports `claude` (`RegisterReq.capabilities.runtimes` — a bare id list
  suffices; no auth information is involved). A codex-only daemon therefore places
  the general agent alone, and the assistant waits for a claude-capable daemon with a
  checklist hint. Widening the allowlist stays with agent-assistant.md.
- The general preset's **runtime is set now**, from the daemon's reported runtimes —
  preferring one whose probe status (below) is `ready` on the current connection,
  else any reported one.
- Placement deliberately does **not** require readiness: an agent placed on a
  logged-out runtime is an ordinary, supported state — the checklist's probe-status
  item (§6.2) is the user-facing signal, and logging in needs no re-placement.
- **One-shot.** A preset's first placement of any kind — auto or manual — stamps
  `preset_agent.placementSettledAt`. Auto-placement only ever considers a preset with
  `daemonId` null **and** no stamp, so a user who unplaces or moves an agent is never
  fought. An unplaced, unsettled preset retries on later register events (capacity
  freed, a claude-capable daemon arriving).
- **Settling is not only placement.** An explicit opt-out settles too, atomically
  with the action: `DELETE /assistant` (which retains the row as `inactive`, v2
  §3.2) and deleting the general preset both stamp `placementSettledAt`. Status
  alone cannot carry this — an unplaced agent is `inactive` as well — so the stamp
  is the only signal the hook consults, and a disable made before any daemon ever
  connects is honored: the next registration must not place, let alone re-enable,
  a disabled assistant. Contract case: disable-before-first-daemon.

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

**Attribution.** The **general** agent stamps `createdByUserId` from the user whose
action created the org (the initial owner; null for the backfill). The **assistant**'s `createdByUserId` is **null**: a built-in carries no personal creator, and
its mutable surface is the owner-gated `/orgs/:orgId/assistant` endpoints regardless
of any grant — generic agent-write routes reject `kind='assistant'` (v2
fixed-property guards) — so conversing is org-wide while configuring stays with
owners. Auto-placement writes an audit row carrying the daemon and the affected
agents.

**Opt-out.** An org-level setting (default on) checked by the creation seam and the
backfill. Self-hosted fleets that want it off globally can set the org default at
deploy time.

### 3.3 Reserved slugs and collisions

Add `RESERVED_AGENT_SLUGS = {'agentconnect', 'agentconnect-assistant', 'agent-assistant',
'assistant'}` validated on `CreateAgentBody`/`UpdateAgentBody`. The existing
`RESERVED_SLUGS` (`http/dto/index.ts`) covers **org** slugs only; agent names have no
protection today, and presets must not be impersonable. This lands **before** any
preset ships.

The built-in assistant's slug becomes `agentconnect-assistant` — brand-prefixed like
its sibling `agentconnect`, and "assistant" rather than "admin" because it serves
every member, not only administrators; update agent-assistant.md P3 when
implementing.

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

## 4. The assistant — delta to agent-assistant.md

Reused unchanged from P3/P4: the `AgentKind` discriminator and partial unique index,
fixed-property guards, the restricted runtime profile, the immutable prompt template,
`GET|PUT|DELETE /orgs/:orgId/assistant`, `denyDelegated` route families, the
confirm-gates on destructive MCP tools, and session privacy by `initiatorUserId`.

Changes this design introduces:

1. **Slug**: `agentconnect-assistant` (§3.3).
2. **Provisioning**: created at org creation (unplaced) and auto-placed at
   first-daemon-online (§3.2), _in addition to_ the owner's `PUT /assistant` for
   move/re-enable. `DELETE /assistant` (disable) is the owner's opt-out after the
   fact.
3. **Prompt**: the immutable template gains an onboarding opening — read
   `getOnboardingStatus` (§6.3) first, propose exactly one next step, act only through
   tools and restate destructive operations before running them.
4. **P4 scope**: only the webchat-token delegated-minting half is required here. IM
   identity binding — and with it any Slack presence for the assistant — stays
   deferred.

Visibility deliberately matches v2 (`org`, fixed): every member gets the
conversational entry, the Playground pins the assistant for everyone, and session
privacy by `initiatorUserId` carries the cross-user isolation (§7).

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
identities remain the upgrade path through quick-install — a step the assistant can
walk a user through.

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
| Meet your agents               | every preset placement-settled — `placementSettledAt` stamped, `skipped`, or the preset deleted (§3.2)                                                                                   |
| Talk to your assistant         | an assistant session exists                                                                                                                                                              |
| Connect Slack                  | a Slack integration exists                                                                                                                                                               |
| Connect GitHub                 | a GitHub App installation exists                                                                                                                                                         |
| Give your agent a repository   | general agent's workspace ≠ scratch                                                                                                                                                      |
| Finish your first conversation | a completed standard-agent session exists                                                                                                                                                |
| Invite teammates               | org member count > 1                                                                                                                                                                     |

### 6.3 One state, two consumers

A single BFF endpoint — `GET /orgs/:orgId/onboarding` → items with status — consumed
by (a) the console checklist and (b) a new AgentConnect MCP **read** tool,
`getOnboardingStatus`, so the assistant opens conversations from the same truth and
proposes the actual next step. Each todo item carries two CTAs: a console deep link,
and "Ask Assistant" (Playground with a prefilled intent). The two surfaces can never
disagree because neither owns the state.

### 6.4 Assistant prompt hook

The assistant's immutable prompt instructs: fetch `getOnboardingStatus` at session
start, lead with the single most valuable incomplete step, and perform setup only
through MCP tools with their existing confirm-gates.

## 7. Security considerations

- **Confused deputy / actor identity**: per-session delegated credentials are a
  prerequisite, not an option — with the assistant open to every member they are the
  entire guarantee: each tool call executes through the REST layer as the initiating
  user, so RBAC and visibility are evaluated live per message and a member can never
  do through the assistant what they could not do in the console. Roles resolve live,
  so a demotion applies immediately. Any static key would authorize and audit as its
  key user rather than the actual actor.
- **Owner-only mutability**: the assistant is configured solely through the
  owner-gated `/orgs/:orgId/assistant` endpoints; generic writes targeting
  `kind='assistant'` are rejected, and delegated principals cannot modify the
  assistant through the assistant (v2 §6.3) — nobody talks the assistant into
  unlocking itself.
- **Cross-user content isolation**: assistant sessions are private to their
  `initiatorUserId` (owners keep the governance exemption), and memory tools stay
  removed — agent memory is shared state, so one member's information must not
  surface in another member's conversation (v2 decisions, unchanged).
- **Provisioning parity**: presets are created through the same validation core as
  `POST /agents` (§3.2), never a raw repo write.
- **Reserved slugs** prevent impersonating built-ins (§3.3).
- **No IM surface** for the assistant until identity binding exists (§4).
- **Auditability**, per path: org-creation provisioning records the creating user
  as actor; the backfill records a system actor (no user performed it);
  auto-placement records a system actor with the daemon and affected agents
  (§3.2); manual placement records the placing user. Every assistant write logs
  through the MCP operation log with the acting user's identity.

## 8. Phasing

| Phase       | Contents                                                                                                                                                                                                                                                                                                                                   | Depends on                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| M0          | Auto-creation, **no new UI**: `RESERVED_AGENT_SLUGS`; nullable `Agent.runtime`; org-creation seam + one-time backfill + `preset_agent` state; the **general** preset created for new orgs and backfilled orgs. The console only needs to tolerate an unplaced, runtime-less agent (render "—"; existing edit/placement paths keep working) | Nothing new                   |
| M1          | Auto-placement at first daemon online + the probe-status facts field — still CP-side only                                                                                                                                                                                                                                                  | M0                            |
| M2          | Console UX: Choose/Add-daemon CTA (§3.4); checklist + `/onboarding` endpoint + `needsOnboarding` rework; Fulfillment A auto-bind                                                                                                                                                                                                           | M0 (M1 for placement states)  |
| M3          | agent-assistant P3 + minimal P4 (webchat delegated key); the **assistant** preset (creation + backfill + auto-placement); `getOnboardingStatus` tool + prompt hook                                                                                                                                                                         | M0–M2                         |
| M4 (hosted) | Distributed Slack app: platform env creds, install route + state, `teamId` schema + composite relay demux, uninstall/revoke lifecycle                                                                                                                                                                                                      | Independent of M3; relay pool |
| M5          | IM identity binding → assistant Slack DMs; guided per-agent app upgrades                                                                                                                                                                                                                                                                   | M3, M4                        |

## 9. Open questions

- Widening the assistant runtime allowlist beyond `claude` (needs a codex-equivalent
  restricted profile) — tracked in agent-assistant.md.
- Final branding: display names and the fixed glyph/color pair for both presets.
- Whether provisioning should also seed a starter cron or memory note (leaning no —
  the checklist plus the assistant cover discovery).
- The exact opt-out surface for self-hosted fleets (org setting vs deploy-time env
  default).
