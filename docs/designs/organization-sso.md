# Organization single sign-on

> **Status:** In progress; §9 says what has landed.
> **Related:** [authorization-policy.md](authorization-policy.md) (the sign-in gate),
> [`packages/setup/README.md`](../../packages/setup/README.md) (the deployment's SSO
> connector), [slack-identity.md](slack-identity.md) (reading a sign-in identity).

## 1. Problem

A deployment has at most one SSO connector today. The operator configures it in the
Setup Server, it lands in the deployment document as `logto.ssoConnector`, and the
login page shows one "Continue with …" button for it. That fits a deployment that
belongs to one company.

On a deployment shared by many organizations (Cloud), each organization needs its own
identity provider. Four things are missing:

1. **Ownership.** There is no connection an organization owns; `auth.sso` is a scalar.
2. **Trust.** The deployment connector is configured by the operator, who is trusted
   for everyone on the deployment. A provider chosen by one organization must have no
   say over anyone outside it (§5).
3. **Entry.** The login page cannot list every organization's identity provider.
4. **Membership.** A person who signs in through an organization's identity provider
   lands with no organization and needs an invite.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | An SSO connection is owned by the deployment (today's connector, unchanged) or by one organization (new). A deployment has one kind: its operator declares organization SSO, and the declaration excludes a deployment connector. |
| D2  | An organization proves it controls an email domain by a DNS record before it can use that domain. A domain belongs to at most one organization.                                                                                   |
| D3  | Binding a verified domain to an active connection makes the connection the only sign-in for that domain at the identity service. Binding is refused until a sign-in through the connection has succeeded.                         |
| D4  | The login page asks for an email address and routes by its domain. Social sign-in buttons stay on the same screen.                                                                                                                |
| D5  | A person who first signs in through an organization's active connection becomes a member of that organization once.                                                                                                               |
| D6  | A deployment that belongs to one company keeps the deployment connector and needs none of this: no domain verification, no lookup, no organization settings.                                                                      |
| D7  | Enforcing is a second, explicit step after activation: an enforced organization accepts a member whose address is in its verified domains only from a browser session that signed in through its connection.                      |

## 3. Model

Two tables in the Control Plane. Identity provider settings and the client secret stay
in Logto, which already owns them for the deployment connector; the Control Plane
forwards a secret on save and does not keep it. The settings card reads the saved
settings back from Logto when an owner opens it, with the secret reported only by
whether one is stored.

```
org_sso_connection
  id, orgId (unique: one connection per organization)
  logtoConnectorId (unique), protocol: oidc | saml, name
  testNonceHash?, testExpiresAt?, testedAt?, activatedAt?, configChangedAt

org_domain
  id, orgId, domain (lowercase; unique among verified rows)
  challenge, challengeExpiresAt, verifiedAt?, lastCheckedAt?, lastCheckOk?
```

Only a verified row holds a domain. Any organization may start a challenge for a
domain, so nobody can block one they do not control: a pending challenge expires, and
when one organization verifies the domain the pending rows of the others are dropped.

A connection is **draft** until `testedAt` is later than `configChangedAt`, **tested**
after that, and **active** once `activatedAt` is set. An active connection whose
settings changed stays active and reads as untested until a test succeeds again.

A connection carries one list in the identity service, Logto's `domains`, and the
Control Plane is its only writer. Logto routes by this list, allows only single
sign-on for it, and links a sign-in to an existing account only when the account's address is
in it. The list holds the organization's verified domains in two situations and is
empty otherwise:

- while the connection is **active**;
- during a **test window**, the ten minutes after an owner starts a test sign-in.

A draft or deactivated connection therefore routes nobody and restricts nobody. It
also cannot reach an existing account, which is why a test needs the window: the
owner's own account links only while their domain is listed.

The rows are the desired state. A write to Logto follows the row and sets a whole
value, so a retry or a second Control Plane instance converges on the same result. If
the Logto connector is gone, after an identity service was rebuilt for instance, the
connection shows as needing its configuration again: the secret is not kept, so the
connector cannot be recreated on the owner's behalf. The owner's view finds this when
it reads the settings back and the connector is not there.

The Logto connector is named after the organization id. `connectorName` is unique in
Logto, and the Setup-managed connector keeps its fixed name, so the two never collide.

## 4. Flows

### 4.1 Setting up (organization owner)

One card in organization settings, three steps in order:

1. **Add a domain and verify it.** The card shows a TXT record to create at
   `_agentconnect-challenge.<domain>`. "Verify" resolves it from the Control Plane. A
   domain another organization has verified is refused.
2. **Configure the connection and test it.** OIDC takes issuer, client id, client
   secret and scopes; SAML takes a metadata URL or document and an attribute mapping.
   The card shows the callback URL, ACS URL and entity id to enter at the identity
   provider. These exist before the first save: the connector is created first, with
   no settings, so the owner can register the application at the identity provider
   and then enter the client id and secret it issues. An OIDC save carries the client
   secret unless the issuer is unchanged, in which case Logto keeps the stored one;
   Logto sends the secret to the issuer's token endpoint, so a secret never carries
   over to a different issuer.
   "Test sign-in" needs a verified domain. It opens the test window, mints a one-time
   nonce and starts a sign-in directly against this connector. The landing page
   presents the nonce; the Control Plane marks the connection tested when the account
   that landed holds an identity on this connector. The nonce shows an owner started
   the test; the identity shows the provider works. An account the sign-in check
   refuses (§5) never presents the nonce, so a provider that returns no usable
   address fails the test, and the page says that the address is what is missing.
   It also lists the names, never the values, of the attributes the provider sent
   with that sign-in, so the owner can pick the email attribute from what the
   provider actually sends instead of guessing. The attributes whose value is an
   address in the organization's verified domains come first and are marked, since
   one of them is the attribute to choose; when none is marked, the provider sends
   no such address at all. The window closes when the test
   succeeds, when the settings change, when the connection is deactivated, or after
   ten minutes. While it is open, the organization's domains sign
   in only through the connection, as they do once it is active; the card says so
   before starting.
3. **Activate.** Offered only when a domain is verified and the connection is tested.
   Activation resolves the DNS records again before it binds, and is refused when one
   no longer carries its challenge. From this moment addresses in those domains sign
   in only through the connection. A domain verified while the connection is active
   is bound when it is verified.

**Changing the settings** takes effect at once and clears the test result. An active
connection stays active: unbinding to rotate a secret would re-open other sign-in
methods for the domain. An enforced connection stops being enforced (§4.5), since
the rule must not rest on settings nobody has signed in through; an owner enforces
again from a session through the changed connection. The owner is still signed in and tests again;
if the new settings are wrong and nobody can sign in, a deployment `ADMIN`
deactivates. Changing the protocol starts a new connector with new service-provider
values.

An organization-owned OIDC connection takes the address as the provider sends it,
whether or not the ID token marks it verified: the connector is always written with
`trustUnverifiedEmail` on, and the owner has no setting for it. The flag is the
provider's own statement, and the owner chose the provider, so requiring it would
stop no owner and would only shut out providers whose tokens carry no
`email_verified` claim. What bounds the address is unchanged: the identity service
links by address only inside the connector's `domains`, and the sign-in check admits
only an address inside the organization's verified domains (§5). What this accepts
is the organization's own risk: a provider that lets its users set their own address
lets one of them present a colleague's address in the same domains. A SAML
connection has no such flag; its email attribute must name one the assertion
carries, or the account arrives with no address and is refused.

Configuration changes, activation and deactivation are audited with their actor, owner
or `ADMIN`.

**Deactivating** empties the list, which lifts the restriction. People who already
signed in through the connection keep an identity on it and can still use it. An
owner can deactivate their own connection, and a deployment `ADMIN` can deactivate
any connection, which is the recovery path when an identity provider breaks after
activation.

**Removing** the connection deletes the connector and every identity it established.
Accounts stay, and their owners sign in by another method.

**Releasing a domain.** An owner can release a pending claim at any time, and a
verified domain only when the organization has no connection: the identities on a
connection were established on that domain's word, so the connection is removed
first. A deployment `ADMIN` can release any domain, for an organization that has
lost control of one; a verified domain takes the connection with it.

### 4.2 Signing in

When organization SSO is on, the login page shows an email field above the social
buttons.

- The page posts the address to an anonymous lookup, which answers with a connector
  to start (`{ connectorId, name }`) or nothing.
- With a connector, the page starts the same direct sign-in it uses today for the
  deployment connector.
- With nothing, the page stays where it is and points at the social buttons. There is
  no password sign-in, so the field has no further step for such an address.
- The lookup decides by domain, never by whether the address has an account. It
  answers from an in-memory snapshot of the active domains, refreshed at most every
  fifteen seconds, so an anonymous request costs no query; limiting request volume
  is the ingress's job. It does reveal that a domain uses SSO; that is accepted.
- The browser remembers the last method that worked and puts it first next time. The
  server is not asked.

The field is a convenience, not the control. Logto refuses password, code and social
sign-in for an address whose domain is bound to a connector, whatever the page shows.

A deployment with only a deployment connector keeps its single button.

### 4.3 Membership

The join is its own step: the console calls `POST /sso/join` after a sign-in. It reads
from the identity service which connections the caller holds an SSO identity on, and
it is idempotent on the join record. It does not ride on the sign-in gate, which
resolves a subject once per process and so would miss an existing account's first
sign-in through a connection.

- A caller with an identity on an organization's active connection, an address in
  that organization's verified domains, and no join record for that organization,
  gets a membership as `collaborator` (the role an invite link grants) and a join
  record. The join is audited.
- A caller who is already a member keeps their role and gets the join record.
- The join record outlives the membership. An owner who removes such a member is not
  overruled at the person's next sign-in; they can be invited back.
- Removing someone at the identity provider stops new sign-ins through the
  connection. On an enforced connection no new session then reaches the
  organization (§4.5), whatever other sign-in identities the account holds. On an
  active connection that is not enforced, an account that has also linked a social
  identity reporting another address still signs in with it and reaches the
  organization. A session already signed in lasts until it ends, and the membership,
  API keys and OAuth grants stay. Ending those needs the provider to notify the
  deployment, which is out of scope here (§7).

### 4.4 Claiming an invited row

Unchanged for addresses outside any bound domain. For an address inside one, the
existing claim by email relies on §5: only that organization's connection can assert
the address.

### 4.5 Per session

The identity service refuses another sign-in method for an address in a bound
domain, but it judges the address that sign-in reports. An account holds several
sign-in identities, and a linked social identity may report another address or none,
so that refusal alone does not keep such an account out of the organization. An owner
who enforces the connection makes the organization check it on every request:

- **Two steps.** Activating binds the domains and routes their addresses to the
  connection (§4.1). Enforcing is a separate owner action on an active connection,
  and stopping it leaves the connection active.
- **The rule.** A request to an enforced organization, from an account whose address
  is in that organization's verified domains, must come from a browser session whose
  latest sign-in went through its connection. Otherwise it is refused with 403
  `ORG_SSO_SIGN_IN_REQUIRED`. The account's other organizations are unaffected, and
  so is anyone whose address is outside the verified domains.
- **Who may enforce.** An owner whose own address is in the verified domains and
  whose current session signed in through the connection (409
  `SSO_ENFORCER_OUTSIDE_DOMAINS` or `SSO_SIGN_IN_REQUIRED` otherwise). That one check
  shows there is an owner the connection speaks for, that this owner's account links
  through it, that the claims script is in place, and that all of it works right
  now, so enforcing cannot be the act that locks every owner out. The rule then
  applies to owners exactly as to any other member: there is no owner exemption and
  no recovery code. An organization whose owners are all outside the verified
  domains cannot enforce, and a deployment `ADMIN` cannot enforce on its behalf.
- **Undoing it.** When the identity provider breaks, a deployment `ADMIN` stops
  enforcing (`POST /admin/orgs/:orgId/sso/connection/stop-enforcing`) or deactivates
  the connection; an owner can also stop enforcing from a session the rule accepts.
  Deactivating, and changing the settings (§4.1), end the enforcement, so it comes
  back only when an owner enforces again.
- **What the token carries.** The identity service's access-token claims script adds
  `sso_connector_id`: the connector of an SSO verification in the session's latest
  sign-in, when its identity (issuer and subject) is one the account holds. A
  verification of someone else's identity in the same sign-in does not count. The
  script runs on every issuance, refreshes included, and reads the browser session's
  latest sign-in, so the claim follows that session: a later sign-in by another
  method in the same browser drops it from tokens issued afterwards, a later sign-in
  through the connection adds it, and a session that has ended yields none. The
  method belongs to a session, not a subject, so nothing caches it; the account's
  address and whether the connector exists are cached for a minute.
- **Who configures it.** The Setup Server owns the script while organization SSO is
  declared, and reports a missing or different one as drift (§6.1). The script also
  carries the role names the Control Plane reads for `ADMIN`, so it replaces a
  script that did only that. Until it is applied no session carries the claim, and
  members inside the domains cannot open the organization.
- **Where it is checked.** In the guard of the `/orgs/:orgId` subtree, after
  membership, so a non-member learns nothing about the organization's sign-in; and
  where a credential for the organization is minted or reissued outside that
  subtree: a personal API key (`POST /me/keys`, its edit and its regeneration) and an
  OAuth grant (`POST /oauth/consent`). Revoking a key stays open.
- **Who it applies to.** Browser sessions only: requests authenticated by an access
  token of the identity service. API keys, OAuth tokens, service accounts and an
  agent's delegated calls carry no sign-in method. They were issued earlier and keep
  working; ending them when someone leaves needs the identity provider (§7).
- **When it applies.** Only an enforced connection with a verified domain. A draft, a
  test window, an active connection not enforced, and a deactivated or removed
  connection do not. Nor does an enforced connection whose connector is gone from
  the identity service, since nobody could sign in through it. Enforcing and
  stopping take effect within the lookup's fifteen seconds (§4.2). When the account's address cannot be read and none
  is cached, the request answers 503.
- **The console.** `GET /orgs` returns, for each organization, `ssoSignIn` (the
  connector and its name) when this session must first sign in through it. The
  console then shows, in place of the organization's pages, its name and the
  connection with one action, "Sign in with" the connection, which starts the same
  direct sign-in as the login page and returns to the same page. The rail and the
  organization switcher stay, so the other organizations remain one click away. A
  refusal on any request makes the console read the list again, which covers a
  connection activated while it was open.
- **An account that never signed in through the connection**, such as one invited
  earlier, gets in by signing in through it: the address links the new SSO identity
  to the same account (§5), and its session carries the claim.
- **Enforcing.** An owner inside the domains who ran the test sign-in already holds a
  session through the connection, so the precondition is usually met where the
  connection was set up.

## 5. What must hold for an organization's connection

An organization owner chooses the identity provider, so on a shared deployment the
provider is untrusted input. Two things must hold:

- **R1.** A connection speaks only for addresses in its organization's verified
  domains. It can neither reach nor create an account with any other address.
- **R2.** An identity established through one connection is never accepted through
  another.

Three parts provide them.

- **The identity service** links a sign-in to an existing account only when the
  address is in the connector's `domains`, and binds an identity to the connector
  that established it. Organization SSO needs a Logto release that does both.
- **The Control Plane, at sign-in.** Before a subject is admitted, an account that
  holds an identity on an organization's connection must have its address inside
  that organization's verified domains. Otherwise the sign-in is refused. An account
  with no address at all is refused the same way: the provider sent none, or the
  connection reads it from a claim or attribute the provider does not send, and the
  account would be a member of nothing. An account that has no local user yet is
  also removed from the identity service; one that has is left for an administrator.
  The refusal is audited without the address. It answers `403 SSO_ADDRESS_REQUIRED` with
  `details: { attributes: string[], addressAttributes: string[] }`. `attributes` are
  the keys of the `detail` Logto stores on the account's identity on that connector,
  read before the account is removed (raw attribute names over SAML, mapped profile
  fields over OIDC). `addressAttributes` are those whose value (a string, or any
  element of an array of strings) is an address in the organization's verified
  domains; only the value's domain is read, and no value leaves the Control Plane.
  Both lists are bounded in count and length, since a hostile provider chooses them,
  and are rendered as text. A
  remembered refusal answers with the same body. Other refusals keep
  `403 SIGN_IN_IDENTITY_REQUIRED`.
- **The Control Plane, as the only writer** of each connector's `domains` (§3), and
  of nothing but verified domains.

**The declaration.** The Setup Server cannot read which Logto release it faces, so
organization SSO is on only where the operator declares it (D1). The deployment
guide names the minimum Logto release, and a deployment on an older one, or on Logto
Cloud, keeps the deployment connector as its SSO. Saving the declaration runs the
same Logto reconcile as saving the deployment connector, so single sign-on follows the
saved document without a separate apply step, and a failed reconcile is shown where the
operator saved.

Domain ownership and uniqueness are the Control Plane's job. Logto does not verify
ownership and lets two connectors list the same domain; it only refuses a list of
public mail domains.

## 6. API

Under `/orgs/:orgId/sso`, `interactiveOnly` (they manage how an organization's people
authenticate, and one of them carries a client secret), and owner-only except `GET /`:

| Route                               | Purpose                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                             | Any member: an owner gets domains, connection state, service-provider values and the saved settings; others get verified domains and the state alone. |
| `POST /connection/service-provider` | Create the connector if needed and return its service-provider values; refused for the other protocol while a connection exists.                      |
| `POST /domains`                     | Add a domain; returns the challenge.                                                                                                                  |
| `POST /domains/:id/verify`          | Resolve the TXT record now.                                                                                                                           |
| `DELETE /domains/:id`               | Release a domain; a verified one only when no connection exists.                                                                                      |
| `PUT /connection`                   | Create or update the connection; clears the test result.                                                                                              |
| `POST /connection/test`             | Open the test window and mint the nonce.                                                                                                              |
| `POST /connection/activate`         | Bind the verified domains.                                                                                                                            |
| `POST /connection/deactivate`       | Unbind, and stop enforcing.                                                                                                                           |
| `POST /connection/enforce`          | Enforce per session (§4.5): the caller's address is in the verified domains and their session signed in through the connection.                       |
| `POST /connection/stop-enforcing`   | Stop enforcing; the connection stays active.                                                                                                          |
| `DELETE /connection`                | Remove the connection and the identities it established.                                                                                              |

Outside the organization subtree:

- `POST /sso/test-result`: any signed-in caller presents the nonce.
- `POST /sso/join`: any signed-in caller, after a sign-in (§4.3).
- `POST /admin/orgs/:orgId/sso/connection/deactivate`,
  `POST /admin/orgs/:orgId/sso/connection/stop-enforcing` and
  `DELETE /admin/sso/domains/:id`: a deployment `ADMIN`'s recovery paths (§4.1, §4.5).
- `POST /sign-in/lookup`: anonymous (§4.2).

`/runtime-config` gains one boolean, `auth.organizationSso`, so the login page knows to
show the email field.
`auth.sso` keeps describing the deployment connector.

`GET /orgs` gains `ssoSignIn` per organization, and a refused request carries the
code `ORG_SSO_SIGN_IN_REQUIRED` (§4.5).

### 6.1 Two writers to Logto

The Control Plane becomes a second writer to Logto beside the Setup Server. Each owns
a disjoint part:

| Writer        | Owns                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Setup Server  | The sign-in experience, the one connector with its fixed name, and the access-token claims script while organization SSO is declared. |
| Control Plane | Connectors named after an organization: their configuration and their domains.                                                        |

The Setup Server's desired value for Logto's `singleSignOnEnabled` becomes "a
deployment connector exists, or organization SSO is declared". Without that, its next
reconcile would switch single sign-on off for every organization. Its inspection
leaves connectors it does not own out of the drift report.

The fixed-name connector exists in Logto exactly while the deployment document holds
`logto.ssoConnector`, including the state between creating it and saving its identity
provider. Removing SSO sign-in deletes it in Logto before the document is cleared, so a
failed delete leaves both in place; deleting it also deletes the sign-in identities it
established, which the operator confirms first. A leftover connector would stay a way in
that no setting shows, and Logto keys an SSO identity by issuer and subject, so it would
also block an organization connection on the same issuer from linking anyone who had
signed in through it. A document without the connector therefore reports a remaining
one as drift, and reconcile deletes it; connectors named after an organization are never
touched.

The Control Plane already holds a Logto Management API client; organization SSO adds
the few connector calls it needs beside it.

## 7. Out of scope

- Changes pushed by the identity provider: accounts it creates or deactivates, and
  its groups.
- More than one connection per organization.
- A sign-in address per organization that skips the email step, and sign-in started
  from the identity provider.
- Requiring a particular social provider for a domain.
- Organization-owned connections on a single-company deployment (D6).

## 8. Security notes

- **Verified domains go stale.** The record is re-checked daily. A failing check is
  shown to the owner and to deployment admins; it does not unbind, since unbinding
  re-opens social sign-in for the domain. A deployment `ADMIN` releases a domain whose
  owner has lost it.
- **The domain owner controls sign-in for its addresses everywhere.** A person with
  such an address who also belongs to another organization still signs in through the
  owning organization's provider. This is inherent in binding a domain.
- **Existing accounts move with their address.** Someone who signed up with a social
  provider on a now-bound address is linked to the same account at their first SSO
  sign-in and keeps their memberships. R1 is what makes that link safe.
- **Lockout.** Activation requires a successful test after the last change, and a
  deployment `ADMIN` can always deactivate or stop enforcing. Enforcing binds owners
  inside the domains like any member, so when the provider fails it is the deployment
  `ADMIN` who opens the organization again (§4.5). Settings changed on an active
  connection take effect untested and stop the enforcement (§4.1); binding untested
  settings is chosen over unbinding the domains.
- **A test sign-in can land on a different account** when the provider's address
  differs from the owner's. R1 holds for it, so that account can only be one whose
  address is in a domain the organization has verified. The connection is still
  marked tested; the owner signs back in. The settings card says so before starting.
- **A test window binds.** For up to ten minutes the organization's domains sign
  in only through a connection that is not yet proven. The window closes itself, and
  a background pass closes one whose closing write failed.
- **Deactivating is not removing.** Identities already established keep working
  through a deactivated connection. Ending them takes removing the connection, which
  is why a verified domain cannot leave an organization that still has one.

## 9. Rollout and verification

Each step merges on its own.

1. **Declaration and domains** (landed): the operator's declaration, the domain
   table, DNS verification and the daily re-check.
2. **Connections** (landed): the connection table, connection management against
   Logto, the test window, activation, the sign-in check of §5, the recovery paths,
   and the ownership rule of §6.1.
3. **Sign-in lookup** (landed): the anonymous lookup and the `/runtime-config`
   boolean.
4. **Membership** (landed): the join record and `POST /sso/join`.
5. **Web** (landed): the email field on the login page, the call to `POST /sso/join`
   after a sign-in, the settings card, and the page a test sign-in lands on.
6. **Per session** (landed): the access-token claims script and its drift check, the
   enforce step and the check of §4.5, `ssoSignIn` on `GET /orgs`, and the console's
   sign-in step for an organization. The card's Enforce control follows separately.
7. **User documentation**, once the feature is complete, naming the minimum Logto
   release and saying that activating alone leaves a member with another linked
   sign-in identity able to reach the organization until it is enforced.

Organization SSO stays undeclared on every deployment until its Logto provides §5.

Verification on a staging deployment with a real identity provider, OIDC and SAML:

- A second organization cannot verify a domain the first has verified, and an
  unverified claim blocks nobody.
- R1 and R2 hold for both protocols.
- An account that arrives through a connection with an address outside the
  organization's verified domains, or with no address, is refused and fails a test
  sign-in; the test is refused when the organization has no verified domain.
- A Setup Server reconcile leaves single sign-on on and reports no drift for
  organization connectors.
- After activation: social sign-in with a bound address is refused; the email field
  routes it to the provider; an existing social account with that address arrives as
  the same user.
- A first sign-in creates the membership; removing the member and signing in again
  does not recreate it.
- Changing the configuration clears the test result and blocks activation.
- Deactivating restores social sign-in for the domain.
- Once an owner inside the domains enforces, a member inside the domains who signed
  in with a linked social identity is refused in the organization, reaches it after
  signing in through the connection, and keeps reaching their other organizations
  meanwhile; an owner outside the domains is unaffected and cannot enforce.

Open points:

- A periodic pass that applies the sign-in check of §5 to accounts that have not
  signed in yet, and deactivates a connection that keeps failing it.
- SAML has been read but not yet exercised end to end.
