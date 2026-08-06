# Ingress Tenant Fence

> **Status:** Proposed → implemented in this change
>
> **Scope:** The relay's inbound HTTP demux ladder (core) and the per-assignment
> tenant identity the control plane projects into it.
> Related: [`integration-plugin-architecture.md`](integration-plugin-architecture.md)
> (§11/D6 demux identity, the core-owned ladder), [`shared-bot-relay.md`](shared-bot-relay.md)
> (the relay as the unified inbound plane), [`org-scoped-data-layer.md`](org-scoped-data-layer.md)
> (the same "fence in structure, not in convention" discipline on the CP data layer).

## 1. Problem

A relay pod holds every assigned bot of every organization in one flat pool
(`shared-bot-relay.md` §4). Attributing an inbound HTTP delivery to a bot is
therefore a tenancy decision, and the ladder that makes it lives in core
(`relay-ingress-manager.ts#handleInbound`):

1. composite fast path — `(appId, tenantId)` index hit, assignment-derived;
2. app-only fast path — `appId` index hit (assignment-derived or _learned_);
3. bounded scan — try `plugin.verify` against each bot in the pool.

Rung 3 already carries a tenant fence, but it is derived from
`BotAssignment.teamId`, and **the control plane only ever sets `teamId` for a
distributed (platform) app's install** — the OAuth funnel in
`http/routes/slack-platform-install.ts`. Every other Slack bot — quick-install,
manual credential paste, legacy rows — reaches the relay with `teamId` absent.
For those assignments:

- rung 3 tries them against **every** delivery regardless of its `team_id`, and
- rung 2 can reach them through a _learned_ app-only mapping, which carries no
  tenant check at all.

`plugin.verify` proves only _"this delivery was signed by someone holding this
app's signing secret"_. It does not prove _"…and it came from the workspace
this assignment belongs to."_ When one Slack app's credentials are installed
into two AgentConnect organizations — the same in-house app pasted twice, an
app whose credentials outlived an employee — both bots verify either
workspace's deliveries. Whichever the scan reaches first wins, and rung 2 then
_learns_ that attribution for subsequent deliveries.

The consequence is a cross-organization confidentiality break on the inbound
path: one organization's workspace messages delivered to another
organization's agent.

## 2. What makes the fix cheap

The value the fence needs is already durable and already maintained; it is
simply not on the wire and not consulted.

`Bot.workspaceId` holds the Slack workspace id (`team_id`, from
`auth.test`/OAuth) and the schema comment states it is filled **for every bot
kind** — the quick-install funnel writes it at finalize
(`http/routes/slack-install.ts`), the Settings refresh writes it
(`http/routes/slack-bot-refresh.ts`), and a background reconciler
(`orchestrator/slackBotIdentityReconciler.ts`, driven by
`BotRepo.listSlackMissingIdentity`) backfills rows that lack it.

So the fence needs no new capture path, no migration, and no backfill job of
its own: it needs the existing value projected onto the assignment and checked.

## 3. Decision

**Separate the two roles `teamId` currently conflates.**

| Role                            | Field         | Fence semantics                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demux **index key** (unchanged) | `teamId`      | This bot is one install of a _distributed_ app: siblings share the app id _and_ the signing secret, so it may only be indexed on the composite `(appId, tenantId)` key — and its fence is **strict**: the delivery must name the same tenant, and a delivery naming none has no safe owner among same-secret siblings. This preserves the pre-fence scan guard's fail-closed behavior exactly. |
| Verification **fence** (new)    | `workspaceId` | The tenant this assignment belongs to, for every _other_ install kind. Its fence refuses only a **provable mismatch** (§3.3) — strictness here would break traffic that is correct today.                                                                                                                                                                                                      |

**The fence is asserted on every rung of the ladder**, not only the scan: a
delivery whose tenant hint contradicts the assignment's known tenant is never
attributed to it, however the candidate was reached — composite hit, learned
app-only hit, or scan. Verification and attribution become two separate
questions, which is the invariant that was missing.

One consequence worth naming: when two same-app bots in different workspaces
are both reachable only by scan, the learned app-only mapping may oscillate
between them as deliveries alternate. That is churn in a bounded cache, not a
correctness issue — every resolve re-applies the fence, so a learned entry can
never serve the wrong tenant; it can only miss and fall back to the scan.

### 3.1 Why not simply write `teamId` for every bot

`teamId` being non-null is load-bearing beyond demux: it marks a distributed
platform-app install, participates in the `(slackAppId, teamId)` composite
unique, and drives admission/reauthorization decisions in the platform-app
funnel and the `DemuxIndex.indexAssign` composite-only rule. Populating it for
quick-install bots would silently change bot identity, uniqueness, and
admission semantics to buy a fence. The fence is a distinct concern and gets a
distinct field.

### 3.2 Where the fence lives

In **core** (`relay-ingress-manager.ts`), not in the Slack plugin. The ladder
is core-owned and platform-agnostic, and CLAUDE.md's rule holds: a platform
name is never core knowledge. The plugin already supplies the delivery's tenant
through `extractDemuxHints`; the assignment supplies its own known tenant
generically. Every platform whose deliveries carry a tenant hint gets the fence
without a line of platform code. (Feishu's extractor currently surfaces only
the app id, so the fence is a no-op there until that plugin extracts
`tenant_key` — the core check is already waiting for it.)

### 3.3 The fail-open boundaries, stated on purpose

These apply to the `workspaceId` arm only — the `teamId` arm stays strict
(§3's table). The workspace fence refuses an attribution only when it can
_prove_ the mismatch — both sides must know a tenant:

- **Assignment tenant unknown** (identity capture never succeeded, or the
  reconciler has not yet backfilled): unfenced, exactly as today. Fencing it
  would break live installs whose `auth.test` failed. This converges on its own
  — the reconciler fills `workspaceId`, the CP re-broadcasts the assignment,
  the fence engages — and that convergence path is the reason this residual is
  acceptable rather than permanent.
- **Delivery carries no tenant hint**: unfenced. Not every payload shape
  carries a workspace id, and refusing those would break real traffic; a
  delivery that names no tenant also cannot be _steered_ at a chosen victim.

Both residuals are strictly narrower than today's behavior: this change can
only ever refuse attributions that are provably cross-tenant. It cannot refuse
anything that is attributed correctly today.

## 4. Threat model note

This is not primarily an "attacker" story. The likeliest path to a cross-tenant
attribution is administrative: one Slack app's credentials legitimately present
in two organizations. That makes it a _silent_ failure — no error, no denial,
just another tenant's messages arriving at the wrong agent — which is precisely
the class of bug a structural fence, rather than a convention, should remove.

## 5. The companion admission fence

The delivery-time fence has one case it structurally cannot decide: **the same
app installed into the same workspace by two organizations**. Both rows then
hold the same signing secret _and_ the same tenant — the fence's comparison
passes for both, and attribution falls back to pool order. No delivery-time
check can break that tie; only refusing the second claim can.

That refusal already exists for the distributed platform app: its OAuth
callback resolves the `(slackAppId, teamId)` claim globally and answers a
cross-organization hit with `workspace_taken`, deliberately not naming the
holding organization. This change extends the same admission rule to the
funnels that lack it — `installNewSlackBot`, the tail both the quick-install
finalize and the platform callback share, refuses to create a bot when
**another** organization already holds one for the same
`(slackAppId, workspaceId)`:

- the repository answers a boolean predicate
  (`BotRepo.slackWorkspaceClaimedElsewhere`) — the question is deliberately
  cross-organization, but no foreign row ever crosses the persistence seam;
- the refusal is a 409 whose message never names the holding organization;
- revoked rows still claim: transferring a workspace between organizations is
  an explicit delete-then-reinstall, never a silent capture;
- unknown identity skips the check (same fail-open arm as §3.3 — `auth.test`
  may legitimately be unavailable at install time), and the reconciler's later
  backfill does not retro-revoke an install that was admitted while unknown;
- the check-then-create window takes no lock — a same-instant double claim
  from two organizations is accepted as out of scope, consistent with the
  funnel's existing concurrency posture.

The two fences are complementary, and neither subsumes the other:

|                      | Duplicate claim (same app, same workspace)          | Sibling install (same app, different workspaces)                                            |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Admission uniqueness | **the only fix** — refuse the second claim          | not a violation; legitimately allowed (the platform app itself is one app across many orgs) |
| Delivery-time fence  | cannot tell the rows apart (same tenant both sides) | **the only fix** — same secret verifies both, only the tenant discriminates                 |

This mirrors GitHub's pair exactly: `GithubInstallation.installationId @unique`
is its admission fence, and the per-rule `installationIds` gate is its
delivery-time fence. Slack needs the same two, shaped for a per-app secret.

## 6. Acceptance

Relay-side tests over a pool holding two bots that share one app id **and one
signing secret** but belong to different workspaces:

- a delivery from workspace A is never attributed to the workspace-B bot, on
  each rung independently (composite, learned app-only, scan);
- a learned app-only mapping cannot serve a cross-tenant delivery;
- a bot with no known tenant keeps today's behavior (still attributable), and
  stops being attributable cross-tenant once its tenant is known;
- a delivery with no tenant hint keeps today's behavior.

Plus control-plane tests that the projected ingress bag carries the fence
value for a non-distributed bot (the case that has none today), and that a
second organization's claim of an already-connected workspace is refused with
409 while a same-organization re-install proceeds.

## 7. Non-goals

- **Relay credential-surface reduction** — a relay pod still holds every
  organization's bot secrets; that is the shared-tier topology decision, not
  this fence's concern.
- **Changing `teamId` semantics** or the distributed-app admission rules (§3.1).
- **Per-organization relay sharding / affinity** — deliberately not the answer
  to cross-tenant risk on the shared tier.
