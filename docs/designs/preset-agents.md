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

1. `agentconnect run` connects the org's first daemon.
2. Two preset agents appear automatically: **`agentconnect-admin`**, a built-in
   setup/operations assistant wired to the AgentConnect MCP and available to every
   member, and **`agentconnect`**, a general-purpose agent (coding, code review,
   everyday tasks).
3. The console shows a **Getting-started checklist** derived from real system state.
   Every remaining step has two paths: click through the console, or ask the admin
   agent to do it conversationally — it drives the same control-plane operations
   through the MCP write tools.
4. Connecting Slack is one action: hosted deployments offer a platform-published
   **"Add to Slack"**; self-hosted deployments run the existing quick-install funnel
   against a predefined manifest.

Four pieces, each independently useful: preset provisioning (§3), the admin agent as a
re-triggered agent-assistant (§4), the predefined Slack app (§5), and the checklist
(§6).

## 2. Decisions

| Topic                      | Decision                                                                                                                                                                                                                                                                                               | Rejected alternatives                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin agent identity       | Reuse agent-assistant `kind='assistant'` (P3) wholesale; this design only changes when it is provisioned and its slug                                                                                                                                                                                  | A parallel "preset admin agent" type — two built-ins with admin-tool access doubles the security surface for no product gain                                                                                                                                                                                                                                                                                            |
| Provisioning trigger       | Automatic, CP-side, typically after the org's **first** daemon completes `register/ok` (async, never blocking the handshake). Mechanically the hook runs on any daemon's register / runtime-facts event while a preset remains unsettled, so a deferred preset completes when a capable daemon appears | At org creation — rejected in agent-assistant v2 because no placement target exists and enabling consumes a daemon's budget. First-daemon-online resolves both objections: the placement _is_ the daemon that just connected, and at that moment the org is typically just the owner. Owner-manual-only (v2 status quo) remains as the disable/move/re-enable path                                                      |
| Admin agent visibility     | `org` — available to every member, fixed per agent-assistant v2; sharing/call-policy writes stay rejected (the lock guards openness), and the row carries no personal creator (§3.2)                                                                                                                   | `restricted` / private-to-owner (an earlier revision of this design): delegated credentials already make per-message authority exactly the caller's own, so the privacy bought no security and cost every non-owner the conversational entry. If ever revisited: `restricted` admits the **creator**, and collaborators can enroll daemons — a restricted admin agent must carry no creator grant                       |
| Credential model           | **Minimal P4 is a prerequisite**: delegated-key minting at webchat-token verification, webchat/Playground only. The IM identity-binding half of P4 stays deferred                                                                                                                                      | A static owner-scoped key, even with owner-locked reachability: an org can have several owners, and a static key authorizes and audits as the key's user rather than the actual initiating owner — breaking the inherited credential-is-identity model and §7's acting-user audit guarantee. Any repair (a request/session-bound, non-substitutable actor credential) is the minimal delegated minting already required |
| Preset deletion            | Admin agent: disable, never delete (v2 §3.2 semantics). General agent: freely deletable and **never auto-recreated**                                                                                                                                                                                   | Existence-check provisioning — it resurrects what the user deleted                                                                                                                                                                                                                                                                                                                                                      |
| Idempotency                | **Per-preset durable state**: a `preset_agent` row keyed `(orgId, preset)` with `status ∈ {created, skipped}`, written in the same transaction as the agent row. Absent row = retry-eligible; a row of either status is permanent                                                                      | A single org-level stamp — it cannot encode the partial states this design allows (a one-slot daemon creates only the admin agent; a codex-only daemon only the general one): stamping loses the deferred preset forever, withholding the stamp makes a retry indistinguishable from resurrecting a deletion. Existence check (resurrection); a per-daemon flag (a second daemon would re-provision)                    |
| Non-empty orgs             | **Both presets are created for every org**, whatever agents it already has: the admin agent is a platform capability, and the general agent must exist deterministically because both Slack fulfillments and the GitHub flow bind to it by default                                                     | Creating the general agent only for empty orgs — leaves the predefined Slack app without a deterministic bind target, and an org that pre-created agents still benefits from the branded default; creating neither                                                                                                                                                                                                      |
| Admin agent on Slack       | None in v1 — webchat/Playground only                                                                                                                                                                                                                                                                   | A predefined admin Slack app now: unsafe until Slack-user ↔ AgentConnect-user identity binding exists (P4's deferred half). With only workspace-level identity, anyone in the workspace could borrow the delegated authority                                                                                                                                                                                            |
| Predefined Slack app count | **One** shareable app backing the general agent; dedicated per-agent apps remain the guided upgrade via quick-install                                                                                                                                                                                  | Two apps (admin app deferred, above); one app per preset agent                                                                                                                                                                                                                                                                                                                                                          |

## 3. Preset agents

### 3.1 The two agents

|                       | `agentconnect-admin`                                                                                                                  | `agentconnect`                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Kind                  | `assistant` (P3)                                                                                                                      | `standard`                                                                                        |
| Visibility            | `org`, fixed; sharing/call-policy writes rejected (v2 guards). Mutable only through the owner-only `/orgs/:orgId/assistant` endpoints | `org`, editable                                                                                   |
| Runtime               | A **ready** runtime (§3.2) from the assistant allowlist (`claude`, v2 §8.2)                                                           | First **ready** runtime (§3.2) among the daemon's reported ones                                   |
| Profile               | Restricted: no shell/file tools, locked scratch workspace (v2 §8.2)                                                                   | Ordinary agent profile                                                                            |
| Workspace             | Locked scratch                                                                                                                        | Scratch; attaching a repository is a checklist step                                               |
| MCP                   | Exactly one injected server: the CP AgentConnect MCP with a per-session delegated key (P4). No memory/collab/platform tools           | Daemon defaults, nothing extra                                                                    |
| Icon                  | Fixed brand glyph + color (stable, recognizable — not the random default)                                                             | Fixed brand glyph + color                                                                         |
| Persona               | CP-generated immutable prompt (v2 §8.3) + onboarding opening (§6.4)                                                                   | Preset description: general dev agent — code review, coding tasks, everyday questions             |
| Integrations at birth | None, ever (v1)                                                                                                                       | None; it is the default bind target for the predefined Slack app (§5) and the GitHub install flow |

### 3.2 Provisioning mechanics

**Seam.** A new CP-side hook after `register/ok` and after `facts/daemon-runtimes`
(`ws/handlers/register.ts`, `ws/handlers/daemon-runtimes.ts`) — today the only
first-connect behavior is the hostname name-seed in `daemon.repo.ts`. The task runs
async; the handshake never waits on it. Once every preset is settled (§State) the hook
is a cheap no-op read.

**Ready runtime.** Presence is not readiness — and the current facts cannot even
express readiness. `FactsRuntimeProfile.authRequired` is absent both before a probe
resolves and after a successful one (the CP stores absence as `false`,
`runtime-profile.repo.ts`), so "unprobed" and "probed fine" are indistinguishable;
`modelsSource` is cache-vs-live provenance, set to `probed` for failed probes too.
This design therefore adds an explicit per-runtime **probe status** to
`facts/daemon-runtimes` (additive protocol field, persisted on the profile row):
`pending | ready | auth_required | failed`, stamped by the daemon on each probe
sweep. A runtime is **ready** iff its stored profile carries `status: 'ready'`
**observed on the daemon's current connection** — the facts channel is already
seq-fenced per connection, so the row records the observing connection alongside the
status. Readiness may regress: some logged-out runtimes are only discovered on a live
turn, not by the probe, and the discovery flips the derived state back.

**Provisioning gate.** Creation requires a _current-connection_ `ready` observation.
Rows persisted from a previous session may still say ready after the runtime logged
out, so `register/ok` alone never settles a preset — the daemon probes and re-emits
facts on every CP (re)connect, so waiting for the first current-connection report
costs seconds and no new machinery. (`RegisterReq.capabilities.runtimes` is a bare id
list with no auth information and never enters the predicate.) The checklist item
(§6.2) reads the latest stored status — an offline daemon is already surfaced by the
checklist's first item. A preset that cannot be created yet writes **no state at
all** — absence is what makes the next report retry it — and the checklist's
"Sign in a runtime" item explains the wait. The implementation contract includes:
pre-probe (`pending` ⇒ not ready), a non-auth probe failure (`failed` ⇒ not ready,
surfaced as runtime trouble rather than "signed in"), every-profile-auth-required
(item incomplete, provisioning deferred), and ready→logged-out across a reconnect
(the stale prior-session `ready` must not settle a preset).

**State.** Idempotency and deletion-permanence live in a small per-preset table —
`preset_agent (orgId, preset, agentId?, status, at)`, additive migration:

- **absent** — never attempted, or deferred (no runtime, no capacity): retry-eligible
  on any later register / runtime-facts event, including from a different daemon.
- **`created`** — the agent row was created; written in the same transaction. The row
  is permanent: if the user later deletes the general agent, the state row is the
  tombstone that prevents resurrection.
- **`skipped`** — permanently not created (reserved-name collision §3.3, or org
  opt-out at settle time); the checklist offers the manual path instead.

A single org-level stamp was rejected (§2): it cannot represent one preset created and
the other deferred, which this section explicitly allows.

**Delivery.** Live delivery uses the ordinary `replicateUpsert` push; the
register-reconcile roster remains the backstop if the daemon is mid-flap.

**Validation parity.** Provisioning must not bypass what `POST /agents` enforces
(slug rules, capacity, defaults). The route (`http/routes/agents.ts`) is currently the
creation service; extracting its core into a service callable by both the route and the
provisioner is part of this work — a raw repo write is not acceptable.

**Capacity.** Respect the daemon's `maxAgents`. If only one slot is free, create the
admin agent (the guide); the other preset stays absent and completes when capacity
appears.

**Attribution.** The **general** agent stamps `createdByUserId` from
`Daemon.createdByUserId` (the user who provisioned the daemon key) when present. The
**admin** agent's `createdByUserId` is **null**: a built-in carries no personal
creator, and its mutable surface is the owner-gated `/orgs/:orgId/assistant`
endpoints regardless of any grant — generic agent-write routes reject
`kind='assistant'` (v2 fixed-property guards) — so conversing is org-wide while
configuring stays with owners. The triggering user is recorded in the audit row,
which is where attribution belongs.

**Opt-out.** An org-level setting (default on) checked at trigger time. Self-hosted
fleets that want it off globally can set the org default at deploy time.

**Assistant runtime gap.** A codex-only daemon can host the general agent but not the
assistant (allowlist is `claude` in v2 §8.2). Ship that asymmetry: general agent
created, admin agent left absent (retry-eligible) with a checklist hint; a later
claude-capable daemon completes it. Widening the allowlist needs a codex equivalent of
the restricted profile and belongs to agent-assistant.md.

### 3.3 Reserved slugs and collisions

Add `RESERVED_AGENT_SLUGS = {'agentconnect', 'agentconnect-admin', 'agent-assistant',
'assistant'}` validated on `CreateAgentBody`/`UpdateAgentBody`. The existing
`RESERVED_SLUGS` (`http/dto/index.ts`) covers **org** slugs only; agent names have no
protection today, and presets must not be impersonable. This lands **before** any
preset ships.

The built-in assistant's slug becomes `agentconnect-admin` (clearer next to a sibling
named `agentconnect` than v2's `agent-assistant`); update agent-assistant.md P3 when
implementing.

Collisions: an org that already owns an agent with a reserved name keeps it —
provisioning writes a `skipped` state row for that preset and never renames user
resources; validation grandfathers existing rows.

Namespace adjacency, to prevent confusion while implementing:
`RESERVED_MCP_SERVER_NAME = 'agentconnect'` (the daemon's stdio bridge,
`protocol/frames/agent.ts`) is an **MCP-server** name. Agent slugs are a different
namespace; the collision is cosmetic, not structural.

## 4. Admin agent — delta to agent-assistant.md

Reused unchanged from P3/P4: the `AgentKind` discriminator and partial unique index,
fixed-property guards, the restricted runtime profile, the immutable prompt template,
`GET|PUT|DELETE /orgs/:orgId/assistant`, `denyDelegated` route families, the
confirm-gates on destructive MCP tools, and session privacy by `initiatorUserId`.

Changes this design introduces:

1. **Slug**: `agentconnect-admin` (§3.3).
2. **Provisioning**: automatic at first-daemon-online (§3.2), _in addition to_ the
   owner's `PUT /assistant` for move/re-enable. `DELETE /assistant` (disable) is the
   owner's opt-out after the fact.
3. **Prompt**: the immutable template gains an onboarding opening — read
   `getOnboardingStatus` (§6.3) first, propose exactly one next step, act only through
   tools and restate destructive operations before running them.
4. **P4 scope**: only the webchat-token delegated-minting half is required here. IM
   identity binding — and with it any Slack presence for the admin agent — stays
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
identities remain the upgrade path through quick-install — a step the admin agent can
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
| Meet your agents               | every preset settled — a `preset_agent` row per preset, `created` or `skipped` (§3.2)                                                                                                    |
| Talk to your admin agent       | an assistant session exists                                                                                                                                                              |
| Connect Slack                  | a Slack integration exists                                                                                                                                                               |
| Connect GitHub                 | a GitHub App installation exists                                                                                                                                                         |
| Give your agent a repository   | general agent's workspace ≠ scratch                                                                                                                                                      |
| Finish your first conversation | a completed standard-agent session exists                                                                                                                                                |
| Invite teammates               | org member count > 1                                                                                                                                                                     |

### 6.3 One state, two consumers

A single BFF endpoint — `GET /orgs/:orgId/onboarding` → items with status — consumed
by (a) the console checklist and (b) a new AgentConnect MCP **read** tool,
`getOnboardingStatus`, so the admin agent opens conversations from the same truth and
proposes the actual next step. Each todo item carries two CTAs: a console deep link,
and "Ask Admin Agent" (Playground with a prefilled intent). The two surfaces can never
disagree because neither owns the state.

### 6.4 Admin agent prompt hook

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
- **No IM surface** for the admin agent until identity binding exists (§4).
- **Auditability**: provisioning emits an audit row carrying the triggering user;
  every admin-agent write logs through the MCP operation log with the acting user's
  identity.

## 8. Phasing

| Phase       | Contents                                                                                                                                                                                                               | Depends on                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| M0          | `RESERVED_AGENT_SLUGS`; provisioning seam + `preset_agent` state + runtime probe-status facts field + **general** preset agent; checklist + `/onboarding` endpoint + `needsOnboarding` rework; Fulfillment A auto-bind | Nothing new — ships value alone: install daemon → agent exists → one-click Slack |
| M1          | agent-assistant P3 + minimal P4 (webchat delegated key); admin agent auto-provision; `getOnboardingStatus` tool + prompt hook                                                                                          | M0 seam                                                                          |
| M2 (hosted) | Distributed Slack app: platform env creds, install route + state, `teamId` schema + composite relay demux, uninstall/revoke lifecycle                                                                                  | Independent of M1; relay pool                                                    |
| M3          | IM identity binding → admin agent Slack DMs; guided per-agent app upgrades                                                                                                                                             | M1, M2                                                                           |

## 9. Open questions

- Widening the assistant runtime allowlist beyond `claude` (needs a codex-equivalent
  restricted profile) — tracked in agent-assistant.md.
- Final branding: display names and the fixed glyph/color pair for both presets.
- Whether provisioning should also seed a starter cron or memory note (leaning no —
  the checklist plus the admin agent cover discovery).
- The exact opt-out surface for self-hosted fleets (org setting vs deploy-time env
  default).
