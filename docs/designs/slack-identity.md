# Slack identity

How a Slack account becomes an AgentConnect sign-in method, and the one rule
anything reading that identity has to follow.

## The claims

Sign in with Slack is OIDC. The ID token carries, besides the usual profile
claims:

| claim                           | example             | meaning                                         |
| ------------------------------- | ------------------- | ----------------------------------------------- |
| `sub`                           | `U0EXAMPLE1`        | the OIDC subject (see the distinction below)    |
| `https://slack.com/user_id`     | `U0EXAMPLE1`        | Slack's own user id                             |
| `https://slack.com/team_id`     | `T0EXAMPLE1`        | the workspace                                   |
| `https://slack.com/team_name`   | `Example Workspace` | best-effort label                               |
| `https://slack.com/team_domain` | `example-workspace` | best-effort; addresses the workspace on the web |

Only the two ids are guaranteed. The labels are absent often enough that every
reader needs a fallback — see `workspaceLabel` in `SocialSignInCard.tsx` for the
precedence we use (name → domain → id).

**`sub` and `user_id` carry the same string but are not the same promise.** Slack
advertises a single OIDC issuer, and OIDC requires `sub` to be unique within an
issuer and never reassigned — as an OIDC subject it is therefore Slack asserting
a stable global identifier. `https://slack.com/user_id` is the id from Slack's
own user model, which its Web API documentation describes as workspace-scoped.
The two being equal in a token does not merge those two contracts, and the rule
below rests on the second — not on any claim that the first is unsound.

The sign-in identity is stored by the identity provider, not by us: Logto keeps
the connector's whole decoded payload under `identities.slack.details.rawData`,
and `LogtoIdentityService.slackIdentityFor()` is the one server-side path to it.
AgentConnect persists no Slack sign-in identity and no reverse index from a Slack
user to a console user. It does persist Slack ids elsewhere — see `ownerIdentity`
below.

## The rule: key on `teamId` + `userId`, never `userId` alone

Slack's own user object documentation is explicit:

> Identifier for this workspace user. It is unique to the workspace containing
> the user. Use this field together with `team_id` as a unique key when storing
> related data or when specifying the user in API requests.

So Slack's own data model does not treat a bare `U…` as self-sufficient. Add to
that Enterprise Grid, where a person can carry both a workspace-local id and an
org-wide one. Any map, comparison, allowlist, or column that identifies a Slack
human should therefore be keyed on the pair — not because a collision has been
demonstrated, but because the pair is what Slack tells you to store and it costs
nothing to carry.

`SlackIdentity` returns both ids for that reason. Taking only `userId` from it
compiles, reads naturally, and quietly drops the qualifier Slack asks you to keep.

**What is not claimed.** Logto's connector uses the OIDC `sub` as its identity id,
which is the spec-correct choice, and a live tenant confirms the stored
`identities.slack.userId` is that bare value with no workspace component. It
would be easy to read that as "two workspaces could collide into one Logto
account" — but that would contradict Slack's own single-issuer `sub` contract,
and no authoritative source here establishes it. Treat the pairing rule as
hygiene we control, not as a defect claim about the provider.

### Where Slack ids already appear

- **`ownerIdentity`** (`session_meta`) is `${platform}:${transportScope}:${triggeredBy}`
  — for Slack that is `slack:T…:U…`. This is the pair, persisted, and the
  precedent worth copying: it is unambiguous without any assumption about `U…`
  on its own.
- **`allowedUserIds`** (daemon routing) compares a bare sender id:
  `allowedUserIds.includes(msg.sender.id)` in `router/routing-table.ts`, against
  a sender built as `message.user ?? message.bot_id` in
  `packages/message/src/slack-message.ts` — no team component anywhere.

  This is **reachable today**, and only half-dormant. The Control Plane supplies
  `[]` on every path in `orchestrator/placement.ts`, so no CP-managed integration
  populates it. But a local `agent.json` may set `slack.allowedUserIds` — the
  schema takes any array — and `rulesFromAgent()` copies it into the
  `source: 'config'` routing layer, which is always active, including while the
  CP is offline.

  Where it is populated, do not read the per-integration binding as making it
  pair-safe. An integration is installed in one workspace, but under Slack
  Connect a shared-channel message can be authored from another, so the two sides
  of that comparison are not guaranteed to share a workspace: a foreign-workspace
  author matches on a bare `U…` alone. **Carrying the author's team id into the
  normalized sender is a prerequisite for treating this list as an authorization
  boundary** — for the local path that prerequisite is already outstanding, not
  deferred until someone turns a feature on.

- **`slack_user_config`** is keyed `(orgId, userId)` where `userId` is the
  **console** user, not a Slack one. It stores that person's Slack App
  Configuration token; no Slack id is involved.

Nothing maps a Slack sender back to a console user. That was a deliberate
non-goal when the server-side read was added: it is a read-through, not an index,
and a reverse lookup would need persistence.

## Linking and unlinking run over different Logto surfaces

Not cosmetic — the split is forced, and re-merging it breaks Slack:

- **Link** is driven by the browser against Logto's **Account API**, with the
  user's own token. Logto's Management API has no session context, and Slack's
  connector persists state while building its authorization URI
  (`setSession({ redirectUri })`, read back during the token exchange), so the
  Management API route fails inside Logto with a 500. Apple and the standard
  OIDC / OAuth 2.0 connectors have the same property.
- **Unlink** stays on the CP, on the Management API, because it enforces a
  server-side invariant the browser cannot be trusted with: the last sign-in
  method may not be removed. It needs no connector session.
- The CP still resolves target → connector id, because only it holds the
  Management credential.

Because linking never passes through the CP, the console tells it when one
landed (`POST /me/social-identities/refresh`); otherwise the cached read hides
the new identity until its TTL expires.

Adding an identity also requires proving current account ownership
(`logto-verification-id`) whenever the account has a security verification
method — Logto answers 403 without it. The proof is collected **before** the
provider round trip, since on return the identity is saved with no UI left to
ask in.

## Deployment

`.env.example` carries the setup steps — connector credentials, the two callback
URLs each provider must register, and the Account API permissions. Two points
belong here instead, because they are consequences of the design above rather
than settings to copy:

**Why the provider needs a second callback.** For the Account API flow Logto
passes _our_ `redirectUri` straight through to the provider rather than routing
the response through its own `/callback/<connector-id>`. The provider therefore
redirects the browser directly to `<console-origin>/auth/social/callback`, and
an app that has not registered it rejects the authorization outright — after
showing the user a consent screen, which makes it look like our bug.

**Configuring a connector does not enable sign-in.** Logto keeps two separate
lists: the connectors a tenant has credentials for, and the ones
Sign-in Experience → Social sign-in actually offers. A connector missing from
the second still supports **account linking** — that path resolves the connector
directly — so Profile keeps working while the sign-in button does not. Nothing
surfaces the discrepancy; the tenant's own sign-in preview is the quickest check.
