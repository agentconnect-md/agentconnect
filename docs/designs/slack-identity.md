# Slack identity

How a Slack account becomes an AgentConnect sign-in method, and the one rule
anything reading that identity has to follow.

## The claims

Sign in with Slack is OIDC. The ID token carries, besides the usual profile
claims:

| claim                           | example             | meaning                                                   |
| ------------------------------- | ------------------- | --------------------------------------------------------- |
| `sub`                           | `U0EXAMPLE1`        | the Slack user id — **the same value** as `user_id` below |
| `https://slack.com/user_id`     | `U0EXAMPLE1`        | the user, **within one workspace**                        |
| `https://slack.com/team_id`     | `T0EXAMPLE1`        | the workspace                                             |
| `https://slack.com/team_name`   | `Example Workspace` | best-effort label                                         |
| `https://slack.com/team_domain` | `example-workspace` | best-effort; addresses the workspace on the web           |

Only the two ids are guaranteed. The labels are absent often enough that every
reader needs a fallback — see `slackWorkspaceLine` in the console for the
precedence we use (name → domain → id).

The identity itself is stored by the identity provider, not by us. Logto keeps
the connector's whole decoded payload under `identities.slack.details.rawData`,
and `LogtoIdentityService.slackIdentityFor()` is the one server-side path to it.
Nothing in AgentConnect's own database holds a `T…`/`U…`.

## The rule: key on `teamId` + `userId`, never `userId` alone

Slack's own user object documentation is explicit:

> Identifier for this workspace user. It is unique to the workspace containing
> the user. Use this field together with `team_id` as a unique key when storing
> related data or when specifying the user in API requests.

So a bare `U…` is **not** a global identifier. Two people in two different
workspaces may hold the same one, and on Enterprise Grid a single person holds
several. Any map, comparison, allowlist, or database column that identifies a
Slack human must be keyed on the pair.

`SlackIdentity` returns both ids for exactly this reason. Taking only `userId`
from it compiles, reads naturally, and is wrong.

### Where this already bites, upstream

Logto's Slack connector reports the identity id as `sub`, i.e. the bare `U…`,
so the tenant stores `identities.slack.userId` with no workspace component
(verified against a live tenant: the stored key equals the `user_id` claim and
does not contain the `team_id`). Two Slack accounts colliding on `U…` would
therefore collapse into one Logto account.

That is upstream, in `@logto/connector-slack`, and not something this repo can
fix. It is recorded here because it sets a ceiling on how much a Slack identity
can be trusted as a _primary_ account key, and because a reader who finds our
`teamId + userId` discipline should know why the provider does not share it.

### Where it does not bite today

Two places compare Slack user ids, and both are safe by construction — worth
knowing so nobody "fixes" them into something slower for no reason:

- **`allowedUserIds`** (daemon routing) is per **integration**, and an
  integration is bound to one workspace. Both sides of the comparison come from
  that same workspace, so a bare `U…` is unambiguous there.
- **`slack_user_config`** is keyed `(orgId, userId)` where `userId` is the
  **console** user, not a Slack one. It stores that person's Slack App
  Configuration token; no Slack id is involved.

Nothing currently maps a Slack sender back to a console user. That was a
deliberate non-goal when the server-side read was added: it is a read-through,
not an index, and a reverse lookup would need persistence. Whoever builds it is
the first caller that must honour the rule above.

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
