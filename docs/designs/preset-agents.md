# Design: Preset Agents and Guided Onboarding

**Status:** M0 implemented (reserved slugs, nullable `Agent.runtime`, org-creation
seam + one-time backfill + `preset_agent` state, the `agentconnect` general preset,
console tolerance for unplaced agents, and pool birth — a new org's preset placed
on the daemon pool at creation with the deployment's runtime/model, §3.2), together
with §5.3 Fulfillment B — the
platform-published "Add to Slack" app (deployment credentials, state-bound install route,
`Bot.teamId` + composite relay demux, uninstall/revocation lifecycle) — pulled
forward from M4 so the preset agent is Slack-connectable from day one. M1–M2 remain
proposed. The dedicated assistant agent is **cancelled** (§4) — see the direction
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
dedicated-assistant shape and is kept as the reference for that fold-in; the
assistant slugs are no longer reserved — only `agentconnect` is (§3.3).

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
Slack app (§5), and the checklist (§6). §4 records the fourth that was cancelled —
a dedicated assistant agent — and where its successor lives instead.

## 2. Decisions

| Topic                      | Decision                                                                                                                                                                                                                                                                                                                                                                                         | Rejected alternatives                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant capabilities     | **No dedicated built-in assistant agent** (2026-07-29). Assistant/admin capabilities fold into the single `agentconnect` general preset; the planned first step is the AgentConnect MCP admin toolset inside its **webapp (Playground/webchat) sessions**. `PresetAgentKind` carries only `general`                                                                                              | A second built-in agent — agent-assistant.md's `kind='assistant'` (P3), re-triggered by this design (§4): a separately provisioned identity with admin-tool access costs its own preset row, placement rules, restricted profile, and fixed-property guards for a conversational entry the same toolset can offer from an agent the org already has       |
| Creation & placement       | **Creation at org creation; placement at first daemon.** The preset row is written transactionally with the org itself — unplaced, runtime deferred (§3.2). A CP hook after `register/ok` then auto-places a still-unplaced preset onto the first daemon, one-shot: the first placement of any kind settles it, so a later unplacement by the user is never fought                               | Creating at first-daemon-online (an earlier revision): coupling creation to a daemon imported partial-state machinery, made creation wait on runtime readiness, and left the console empty until a daemon appeared. Creation needs no placement target                                                                                                    |
| Credential model           | **Minimal P4 is the prerequisite** before any admin tool reaches a session: delegated-key minting at webchat-token verification, webchat/Playground only. The IM identity-binding half of P4 stays deferred                                                                                                                                                                                      | A static owner-scoped key, even with owner-locked reachability: an org can have several owners, and a static key authorizes and audits as the key's user rather than the actual initiating owner — breaking the inherited credential-is-identity model and §7's acting-user audit guarantee. Any repair is the minimal delegated minting already required |
| Preset deletion            | **Not deletable** (2026-07-29, reversing the earlier freely-deletable call): the preset is a permanent org fixture — the console hides Delete and labels it `builtin`, and the CP refuses `DELETE /agents/:id` (403) on every surface (REST/MCP/console), because platform defaults (the predefined Slack app §5, the GitHub flow) bind to it deterministically. Never auto-recreated either way | Freely deletable (the launch decision) — leaves the platform's default bind target removable, forcing every default-binding flow to grow a missing-preset repair path; existence-check provisioning — it resurrects what the user deleted                                                                                                                 |
| Idempotency                | **Per-preset `preset_agent` row** (`status ∈ {created, skipped}`, `placementSettledAt`), written with the agent row. Creation is transactional with the org (or the one-time backfill) and never retries; auto-placement retries on register events only while the preset is unplaced and unsettled. A deleted preset is never recreated — creation has no later trigger                         | A single org-level stamp (cannot express per-preset placement); existence-check provisioning (resurrection); creating at daemon time (see the Creation & placement row)                                                                                                                                                                                   |
| Non-empty orgs             | **The preset for every org** — new orgs at creation, existing orgs via a one-time backfill — whatever agents they already have: the general agent must exist deterministically because both Slack fulfillments and the GitHub flow bind to it by default                                                                                                                                         | Creating it only for empty orgs — leaves the predefined Slack app without a deterministic bind target, and an org that pre-created agents still benefits from the branded default; creating none at all                                                                                                                                                   |
| Predefined Slack app count | **One** app backing the general agent, installed per workspace as an **http + non-shareable-by-default** bot (one workspace ⇒ one agent until the user enables sharing on it, §5.5); dedicated per-agent apps remain the guided upgrade via quick-install                                                                                                                                        | One app per preset agent; a second app for a separate built-in assistant (§4)                                                                                                                                                                                                                                                                             |

## 3. Preset agents

### 3.1 The preset agent

|                       | `agentconnect`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display name          | **AgentConnect** — fixed (2026-07-29, together with the icon): the console disables renaming and the CP refuses the PATCH                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Kind                  | An ordinary agent row — no schema discriminator; the agent DTO carries a derived `builtin` flag (a `preset_agent` row references it) driving the console's lowercase `builtin` label and the delete refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Visibility            | `org`, editable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Runtime               | **Unset at creation** (deferred, §3.2); set at placement from the daemon's reported runtimes, preferring a `ready` one. On an install that runs a daemon pool the preset is born placed on it instead, carrying the deployment's configured pool runtime and model (§3.2 "Pool birth")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Profile               | Ordinary agent profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Workspace             | Scratch; attaching a repository is a checklist step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MCP                   | Daemon defaults, nothing extra. The planned successor to §4 adds the AgentConnect MCP admin toolset to its **webapp sessions only**, gated on the per-session delegated key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Skills                | The `agentconnect-platform` skill enabled by default — platform introduction plus admin guidance honoring webchat-preset-agentconnect-mcp.md invariants 5/10: the agent executes admin calls only through the AgentConnect MCP toolset when a session has it; with no admin tools it never calls the REST surface itself under any credential (invariant 10 rejects static user-key authority however provisioned) and instead directs the user to the console or helps them drive the REST API as their own client — a key never enters the conversation. Provisioning registers an ordinary org skill source named `agentconnect` (the dedicated `agentconnect-md/agentconnect-skill` repo's `skills/` dir, pinned by numeric GitHub repo id) in the same transaction; if the org already owns that source name, the source is left untouched and the preset ships without default skills. Both stay ordinary editable resources |
| Icon                  | Fixed brand glyph — the native AgentConnect diamond, rendered plateless on every surface (no background, the stored color is inert; not the random default). Not editable: display-only avatar in the console; the CP refuses PATCH and upload/reset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Persona               | Preset description: general dev agent — code review, coding tasks, everyday questions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Integrations at birth | None; it is the default bind target for the predefined Slack app (§5) and the GitHub install flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 3.2 Creation, placement, and state

**Creation — at org creation, unplaced.** One transaction, run by the org-creation
service seam (every path — `POST /orgs`, the no-auth default tenant — funnels
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

**Pool birth — placed at creation when the install runs a pool.** An unplaced
preset is a promise the install can only keep once a machine arrives; an install
that already runs a daemon pool has one, so the preset is placed on the pool
inside the same creation transaction and the org's first screen shows a working
agent. Three parts:

- **The predicate is membership, not the set.** The org-less `member_set` row is
  minted by migration on every install, so its existence says nothing; the pool
  having **at least one member** is what tells a pool-backed deployment from a
  pool-less one — a pool is an ordinary deployment shape, self-hosted installs
  included, so this is not a hosted-only path. `PoolMemberReaper` retires a
  replaced Pod's membership inside
  its window, so the signal does not go stale. No member ⇒ born unplaced, exactly
  as before, and a pool that arrives later never retro-places (creation has no
  later trigger; auto-placement below is the one that does).
- **The exec config comes with the placement**, and is **deployment policy**:
  `PRESET_AGENT_POOL_RUNTIME` (default `dsh-acp`) and `PRESET_AGENT_POOL_MODEL`
  (default `deepseek-v4-flash`). One pool image is one runtime set shared by every
  org, so which runtime is installed and signed in there is the deployment's
  answer, not a per-org choice — and it must be a runtime the pool holds
  credentials for, or the org's first turn fails on a login it cannot perform. An
  empty runtime is the opt-out; an empty model leaves the runtime's own default.
- **Born placed ⇒ born settled.** The `preset_agent` row is stamped
  `placementSettledAt` in the same transaction, so auto-placement never moves what
  the org already runs on and never fights a later unplacement.

Only genuinely new orgs are born on the pool. `ensurePresetAgentsProvisioned` — the
backfill and the no-auth default tenant — deliberately provisions unplaced: it
runs against orgs of unknown age that have already chosen where they run.

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
  delete-before-first-daemon. (Since the 2026-07-29 not-deletable decision (§2) the
  API refuses preset deletion, so this stamp path is a defensive backstop — it
  still covers presets deleted before the rule shipped and any out-of-band removal.)

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
opt-out). Deletion is refused at the API since 2026-07-29 (§2), and needs no
tombstone mechanics regardless: creation has no later trigger, so nothing can
resurrect a preset deleted before that rule (or removed out-of-band) — the row
remains as the record the checklist derives from (§6.2).

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
backfill. Setup Server controls the deployment default for self-hosted fleets.

### 3.3 Reserved slugs and collisions

Add `RESERVED_AGENT_SLUGS = {'agentconnect'}` validated on
`CreateAgentBody`/`UpdateAgentBody`. The existing `RESERVED_SLUGS`
(`http/dto/index.ts`) covers **org** slugs only; agent names have no protection
today, and presets must not be impersonable. This lands **before** any preset ships.

Only the shipped preset's own slug is reserved (2026-07-29; the launch set also
parked `agentconnect-assistant`/`agent-assistant`/`assistant`). The assistant names
were released once the dedicated assistant was cancelled (§4): its capabilities fold
into the `agentconnect` agent itself, so no future built-in will claim them and
users may take them freely.

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

## 4. The assistant agent — cancelled

A previous revision of this design re-triggered agent-assistant.md's built-in
assistant agent (P3, `kind='assistant'`, slug `agentconnect-assistant`) as a
SECOND preset. **That is cancelled** (2026-07-29): it is never provisioned, has
no preset row, no auto-placement, and no `AgentKind` discriminator ships.
`PresetAgentKind` carries only `general`; the assistant slugs were released from
the reserved set (§3.3) once the cancellation settled — nothing built-in will
ever claim them.

Assistant/admin capabilities fold into the one `agentconnect` general preset
instead (§3.1). The planned first step: the AgentConnect MCP admin toolset
becomes available inside that agent's **webapp (Playground/webchat) sessions**,
gated on the per-session delegated credential of agent-assistant.md §4 (P4's
webchat half) — still the security prerequisite, still unbuilt.

Little of the cancelled shape transfers, which is why it is not retained here:
its identity machinery (a `kind` discriminator, fixed-property guards, a
dedicated `/orgs/:orgId/assistant` surface) exists to make a second built-in
agent unlike an ordinary one, while the successor's host IS an ordinary,
user-editable agent — and its mandatory restricted runtime profile (no shell, no
file tools) is actively wrong for a general-purpose development agent. What DOES
carry over is documented in the live sections it belongs to: session-bound
credential minting in agent-assistant.md §4, and the closed, auditable,
confirm-gated tool surface in §6. The full cancelled design is in git history
(this file before 2026-07-29) if the rationale is ever needed.

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

- **Platform credentials.** The distributed Slack App identity and its write-only
  client and signing secrets live in the DB-backed deployment configuration and
  are edited through Setup. Without that provider configuration, the
  one-click platform App is absent and the per-agent setup paths remain available.
- **Install starts from the console.** The OAuth callback strictly requires a `state`
  resolving to a pending-install row (`routes/slack-install.ts` renders denied/expired
  otherwise), and a bare share URL cannot carry org/agent tenancy. A new route mints
  `state` binding `{orgId, targetAgentId, userId}` and redirects to the authorize URL;
  any public landing page can only bounce the user back into their console.
- **Callback branch.** Exchange with the platform credentials and **persist `team.id`
  and `bot_user_id`** — today `SlackOAuthResult` deliberately drops `team.id`
  (`http/slack-config-api.ts`).
- **Schema.** `Bot.teamId` (nullable when no workspace was captured), projected
  into the `(platform, externalAppId, externalTenantId)` unique; multiple `Bot`
  rows may now share one `slackAppId` across orgs.
- **Relay demux.** Today demux is a learned `api_app_id → botId` map with a
  signing-secret brute scan as fallback (`relay/src/relay-ingress-manager.ts`). Every
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
- **Console surface: the preset agent only.** Add-integration offers the one-click
  "Add to Slack" pane on the **`agentconnect` preset** (`AgentDto.builtin`) and on no
  other agent, even where the platform app is configured: the deployment publishes one
  Slack app, its workspace install binds to the preset, and a second agent clicking it
  can only hit `agent_taken` (§5.5). Every other agent opens straight on the custom
  bot-identity flow — its own app via quick-install (§5.2 machinery), or reuse of a
  freed / shared bot. The start route still accepts an explicit `agentId` (the API
  path that widens an already-shared workspace bot); the console never sends one for a
  non-preset agent.

### 5.4 The scope contract

Public distribution freezes the scope list: widening it later forces every installed
workspace to re-authorize. The pinned lists (currently 17 bot scopes including
`mpim:history`/`mpim:read`/`im:write`/`commands`, and events including `message.mpim`)
are the launch contract, enforced by the cross-package drift guards. Any future
widening is a product event — a coordinated re-auth — not a routine PR.

### 5.5 One app, http + non-shareable by default

Every workspace install of the platform app produces a Bot that is **always
`transport: 'http'` and installs with `shareable: false`** — the transport is
never a choice; sharing is a later, deliberate opt-in:

- **http** is forced by the platform: a distributed app has no per-workspace
  app-level (xapp) token, so Socket Mode is impossible and inbound must arrive
  over the relay pool's shared Events API endpoint.
- **non-shareable by default** is the product decision: one workspace install
  backs exactly **one agent**, keeping the classic 1-install cap, and no reuse or
  re-install may **silently** widen it (2026-07-29 update; originally the bot was
  non-shareable outright). The user may flip the bot's sharing toggle
  (Settings → Bots — the ordinary `PATCH /bots/:id` surface, no `teamId`
  special-case), after which the workspace app behaves like any shared http bot:
  the Add-integration reuse path offers it and adds agents, and an "Add to Slack"
  re-install aimed at another agent adds that agent instead of failing. Dedicated
  per-agent apps remain the quick-install upgrade where the operator owns the app
  and its scopes.

Consequence for re-authorization while NOT shared: a re-install aimed at a
**different** agent than the workspace's current binding does not silently add a
second install. The credential still rotates (the workspace keeps working), and
the callback answers `agent_taken` — moving the binding is a deliberate console
action, not a side effect of clicking "Add to Slack" with another agent selected.
Once the bot is shared, the same re-install simply adds the new agent's install.

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

| Item                          | Derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon connected              | daemon status `ready`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Runtime signed in             | at least one **ready** runtime (§3.2, latest stored probe status) — non-empty profiles are not enough: they include installed-but-logged-out (`auth_required`) and failed-probe runtimes                                                                                                                                                                                                                                                                                                                                         |
| Meet your agent               | the preset is placement-settled — `placementSettledAt` stamped, `skipped`, or the preset deleted (§3.2; legacy — deletion predating the §2 not-deletable rule)                                                                                                                                                                                                                                                                                                                                                                   |
| Connect Slack                 | a Slack integration exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Connect GitHub                | a GitHub App installation exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Give your agent a repository  | general agent's workspace ≠ scratch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Start your first conversation | any session exists in the org (2026-07-30: a session existing at all means a conversation has been driven here — Playground or channel; requiring a terminal status made orgs with live sessions re-run a chat just to clear the step). Derived from `GET /sessions`' first-page `orgHasSessions` — a bare org-wide boolean computed without the visibility predicate, so restricted/private-only orgs report correctly while exposing nothing about hidden rows; the caller-visible list is only the unloaded/older-CP fallback |
| Invite teammates              | org member count > 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
- **Reserved slugs** prevent impersonating built-ins (§3.3) — exactly the
  shipped preset's own slug.
- **Auditability**, per path: org-creation provisioning records the creating user
  as actor; the backfill records a system actor (no user performed it);
  auto-placement records a system actor with the daemon and affected agent
  (§3.2); manual placement records the placing user. Every MCP write logs through
  the operation log with the acting user's identity (agent-assistant.md §9.3).
- Per-initiator session isolation and the confirm-gated, auditable tool surface
  remain requirements of the successor shape (§4) and are specified where they
  live: agent-assistant.md §4 (credential) and §6 (tools).

## 8. Phasing

| Phase                  | Contents                                                                                                                                                                                                                                                                                                                               | Depends on                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| M0                     | Auto-creation, **no new UI**: `RESERVED_AGENT_SLUGS`; nullable `Agent.runtime`; org-creation seam + one-time backfill + `preset_agent` state; the general preset created for new orgs and backfilled orgs. The console only needs to tolerate an unplaced, runtime-less agent (render "—"; existing edit/placement paths keep working) | Nothing new                   |
| M1                     | Auto-placement at first daemon online + the probe-status facts field — still CP-side only                                                                                                                                                                                                                                              | M0                            |
| M2                     | Console UX: Choose/Add-daemon CTA (§3.4); checklist + `/onboarding` endpoint + `needsOnboarding` rework; Fulfillment A auto-bind                                                                                                                                                                                                       | M0 (M1 for placement states)  |
| M3 (planned successor) | Admin tools inside the general preset's **webapp (Playground/webchat) sessions**: minimal P4 (per-session delegated key) first as the security prerequisite, then the AgentConnect MCP admin toolset scoped to those sessions, plus the `getOnboardingStatus` read tool (§6.3). Replaces the cancelled dedicated assistant preset (§4) | M0–M2; agent-assistant.md P4  |
| M4 (hosted)            | Distributed Slack app: platform env creds, install route + state, `teamId` schema + composite relay demux, uninstall/revoke lifecycle. **Pulled forward and implemented in M0** (§5.3)                                                                                                                                                 | Independent of M3; relay pool |
| M5                     | Guided per-agent Slack app upgrades. Any admin surface outside webapp sessions additionally needs the IM identity-binding half of agent-assistant.md P4; the cancelled assistant's Slack DMs went with it (§4)                                                                                                                         | M3, M4                        |

## 9. Open questions

- Whether provisioning should also seed a starter cron or memory note (leaning no —
  the checklist covers discovery).
- The exact opt-out surface for self-hosted fleets (org setting vs deploy-time env
  default).
- How far the successor shape (§4) scopes the admin toolset inside a general-purpose
  agent's webapp sessions — the general preset is an ordinary, shell-capable agent,
  so the cancelled design's restricted-profile reasoning does not transfer
  unchanged (agent-assistant.md §8 states what was dropped and why).
