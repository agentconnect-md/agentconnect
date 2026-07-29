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
   setup/operations assistant wired to the AgentConnect MCP and private to the owner,
   and **`agentconnect`**, a general-purpose agent (coding, code review, everyday
   tasks).
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

| Topic                      | Decision                                                                                                                                                                                                                                                                                                                                                                                                       | Rejected alternatives                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin agent identity       | Reuse agent-assistant `kind='assistant'` (P3) wholesale; this design only changes when it is provisioned and its slug                                                                                                                                                                                                                                                                                          | A parallel "preset admin agent" type — two built-ins with admin-tool access doubles the security surface for no product gain                                                                                                                                                                                                                                       |
| Provisioning trigger       | Automatic, CP-side, after the org's **first** daemon completes `register/ok` (async, never blocking the handshake)                                                                                                                                                                                                                                                                                             | At org creation — rejected in agent-assistant v2 because no placement target exists and enabling consumes a daemon's budget. First-daemon-online resolves both objections: the placement _is_ the daemon that just connected, and at that moment the org is typically just the owner. Owner-manual-only (v2 status quo) remains as the disable/move/re-enable path |
| Admin agent visibility     | `restricted` — private to the org's owner(s), locked; sharing and visibility writes are rejected                                                                                                                                                                                                                                                                                                               | `org` per agent-assistant v2's assistant-for-everyone positioning — superseded by this design's product call: the admin agent is the owner's setup/operations assistant. Restricted visibility also adds defense-in-depth on top of delegated credentials. Amend v2's fixed-visibility decision at implementation time                                             |
| Credential model           | **Minimal P4 remains the target**: delegated-key minting at webchat-token verification, webchat/Playground only; the IM identity-binding half stays deferred. Because conversation access is already restricted to owners, an explicitly-interim static owner-scoped key is admissible if sequencing demands it — only with the visibility/sharing lock in place, and it must be replaced by delegated minting | A static owner credential on an org-visible agent (the confused deputy the visibility row guards against); shipping the interim without the hard visibility lock                                                                                                                                                                                                   |
| Preset deletion            | Admin agent: disable, never delete (v2 §3.2 semantics). General agent: freely deletable and **never auto-recreated**                                                                                                                                                                                                                                                                                           | Existence-check provisioning — it resurrects what the user deleted                                                                                                                                                                                                                                                                                                 |
| Idempotency                | Org-level `presetsProvisionedAt` stamp, written in the same transaction as the created rows                                                                                                                                                                                                                                                                                                                    | Existence check (resurrection); a per-daemon flag (a second daemon would re-provision)                                                                                                                                                                                                                                                                             |
| Non-empty orgs             | **Both presets are created for every org**, whatever agents it already has: the admin agent is a platform capability, and the general agent must exist deterministically because both Slack fulfillments and the GitHub flow bind to it by default                                                                                                                                                             | Creating the general agent only for empty orgs — leaves the predefined Slack app without a deterministic bind target, and an org that pre-created agents still benefits from the branded default; creating neither                                                                                                                                                 |
| Admin agent on Slack       | None in v1 — webchat/Playground only                                                                                                                                                                                                                                                                                                                                                                           | A predefined admin Slack app now: unsafe until Slack-user ↔ AgentConnect-user identity binding exists (P4's deferred half). With only workspace-level identity, anyone in the workspace could borrow the delegated authority                                                                                                                                       |
| Predefined Slack app count | **One** shareable app backing the general agent; dedicated per-agent apps remain the guided upgrade via quick-install                                                                                                                                                                                                                                                                                          | Two apps (admin app deferred, above); one app per preset agent                                                                                                                                                                                                                                                                                                     |

## 3. Preset agents

### 3.1 The two agents

|                       | `agentconnect-admin`                                                                                                        | `agentconnect`                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Kind                  | `assistant` (P3)                                                                                                            | `standard`                                                                                        |
| Visibility            | `restricted` (owner-only), locked; sharing writes rejected                                                                  | `org`, editable                                                                                   |
| Runtime               | From the assistant allowlist (`claude`, v2 §8.2)                                                                            | First available from the daemon's reported runtimes                                               |
| Profile               | Restricted: no shell/file tools, locked scratch workspace (v2 §8.2)                                                         | Ordinary agent profile                                                                            |
| Workspace             | Locked scratch                                                                                                              | Scratch; attaching a repository is a checklist step                                               |
| MCP                   | Exactly one injected server: the CP AgentConnect MCP with a per-session delegated key (P4). No memory/collab/platform tools | Daemon defaults, nothing extra                                                                    |
| Icon                  | Fixed brand glyph + color (stable, recognizable — not the random default)                                                   | Fixed brand glyph + color                                                                         |
| Persona               | CP-generated immutable prompt (v2 §8.3) + onboarding opening (§6.4)                                                         | Preset description: general dev agent — code review, coding tasks, everyday questions             |
| Integrations at birth | None, ever (v1)                                                                                                             | None; it is the default bind target for the predefined Slack app (§5) and the GitHub install flow |

### 3.2 Provisioning mechanics

**Seam.** A new CP-side hook after `register/ok`
(`ws/handlers/register.ts`) — today the only first-connect behavior is the hostname
name-seed in `daemon.repo.ts`. The task runs async; the handshake never waits on it.

**Runtime availability.** `RegisterReq.capabilities.runtimes` is known at register
time; the richer `facts/daemon-runtimes` snapshot arrives after `register/ok`,
asynchronously. Provisioning fires at whichever moment first shows a usable runtime:
at register when `capabilities.runtimes` is non-empty, otherwise when runtime facts
land. If no runtime is ever reported, nothing is created — the checklist's first item
("Sign in a runtime") explains why — and the next report retries naturally.

**Transaction.** One transaction: stamp `presetsProvisionedAt` (new nullable `Org`
column, additive migration) + create the agent rows. The stamp is only ever written on
success, so a daemon that never gets a runtime keeps retrying; once stamped, deletion
by the user is final. Live delivery uses the ordinary `replicateUpsert` push; the
register-reconcile roster remains the backstop if the daemon is mid-flap.

**Validation parity.** Provisioning must not bypass what `POST /agents` enforces
(slug rules, capacity, defaults). The route (`http/routes/agents.ts`) is currently the
creation service; extracting its core into a service callable by both the route and the
provisioner is part of this work — a raw repo write is not acceptable.

**Capacity.** Respect the daemon's `maxAgents`. If only one slot is free, create the
admin agent (the guide) and let the checklist surface the rest.

**Attribution.** `createdByUserId` is stamped from `Daemon.createdByUserId` (the user
who provisioned the daemon key) when present; null for CLI/self-registered daemons.
Provisioning writes one audit row either way (org, daemonId, created agent ids).

**Opt-out.** An org-level setting (default on) checked at trigger time. Self-hosted
fleets that want it off globally can set the org default at deploy time.

**Assistant runtime gap.** A codex-only daemon can host the general agent but not the
assistant (allowlist is `claude` in v2 §8.2). Ship that asymmetry: general agent
created, admin agent deferred with a checklist hint. Widening the allowlist needs a
codex equivalent of the restricted profile and belongs to agent-assistant.md.

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
provisioning skips that preset and never renames user resources; validation
grandfathers existing rows.

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
4. **P4 scope**: only the webchat-token delegated-minting half is targeted here. IM
   identity binding — and with it any Slack presence for the admin agent — stays
   deferred. The interim static-key option and its conditions are in §2.
5. **Visibility**: fixed `restricted` instead of v2's fixed `org` (§2). The guards
   that rejected sharing writes now lock privacy rather than openness; the Playground
   pins it for owners only, and v2's non-owner "ask an owner to enable it" surface
   goes away. Session privacy by `initiatorUserId` becomes belt-and-suspenders —
   only owners can initiate a conversation at all.

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

| Item                           | Derivation                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Daemon connected               | daemon status `ready`                                                              |
| Runtime signed in              | runtime profiles non-empty (a real, high-frequency stumbling block — its own item) |
| Meet your agents               | `presetsProvisionedAt` set (auto-completed)                                        |
| Talk to your admin agent       | an assistant session exists                                                        |
| Connect Slack                  | a Slack integration exists                                                         |
| Connect GitHub                 | a GitHub App installation exists                                                   |
| Give your agent a repository   | general agent's workspace ≠ scratch                                                |
| Finish your first conversation | a completed standard-agent session exists                                          |
| Invite teammates               | org member count > 1                                                               |

Items that reference the admin agent render only for users who can see it — the
org's owner(s), given its restricted visibility. Other members see the remaining
items.

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

- **Confused deputy** is eliminated by per-session delegated credentials (the target,
  §2). The admin agent's restricted visibility is what makes the interim static-key
  option admissible at all: the only people who can reach the agent hold the same
  authority the key carries. That equivalence is load-bearing — the interim is safe
  **only while** visibility and sharing stay hard-locked, which is why those writes
  are rejected at the route layer, not by convention.
- **Provisioning parity**: presets are created through the same validation core as
  `POST /agents` (§3.2), never a raw repo write.
- **Reserved slugs** prevent impersonating built-ins (§3.3).
- **No IM surface** for the admin agent until identity binding exists (§4).
- **Auditability**: provisioning emits an audit row; every admin-agent write already
  logs through the MCP operation log with the acting user's identity.

## 8. Phasing

| Phase       | Contents                                                                                                                                                     | Depends on                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| M0          | `RESERVED_AGENT_SLUGS`; provisioning seam + **general** preset agent; checklist + `/onboarding` endpoint + `needsOnboarding` rework; Fulfillment A auto-bind | Nothing new — ships value alone: install daemon → agent exists → one-click Slack |
| M1          | agent-assistant P3 + minimal P4 (webchat delegated key); admin agent auto-provision; `getOnboardingStatus` tool + prompt hook                                | M0 seam                                                                          |
| M2 (hosted) | Distributed Slack app: platform env creds, install route + state, `teamId` schema + composite relay demux, uninstall/revoke lifecycle                        | Independent of M1; relay pool                                                    |
| M3          | IM identity binding → admin agent Slack DMs; guided per-agent app upgrades                                                                                   | M1, M2                                                                           |

## 9. Open questions

- Widening the assistant runtime allowlist beyond `claude` (needs a codex-equivalent
  restricted profile) — tracked in agent-assistant.md.
- Final branding: display names and the fixed glyph/color pair for both presets.
- Whether provisioning should also seed a starter cron or memory note (leaning no —
  the checklist plus the admin agent cover discovery).
- The exact opt-out surface for self-hosted fleets (org setting vs deploy-time env
  default).
