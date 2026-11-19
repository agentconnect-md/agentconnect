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
4. **Membership.** A person whose address is on an organization's domain lands with
   no organization and needs an invite.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | An SSO connection is owned by the deployment (today's connector, unchanged) or by one organization (new). A deployment has one kind: its operator declares organization SSO, and the declaration excludes a deployment connector. |
| D2  | An organization proves it controls an email domain by a DNS record before it can use that domain. A domain belongs to at most one organization.                                                                                   |
| D3  | Binding a verified domain to an active connection makes the connection the only sign-in for that domain at the identity service. Binding is refused until a sign-in through the connection has succeeded.                         |
| D4  | The login page offers "Continue with SSO" beside the social buttons; it leads to an SSO page that asks for an email address and routes by its domain.                                                                             |
| D5  | An organization chooses how new members arrive: by invitation only, or also by an address on one of its verified domains, which makes the account a member once when it signs in. The choice is separate from the connection.     |
| D6  | A deployment that belongs to one company keeps the deployment connector: no domain verification, no lookup, no organization settings. It takes only the member source (§4.3), set on the connector in Setup.                      |
| D7  | Enforcing is a second, explicit step after activation: an enforced organization accepts every member, owners included, only from a browser session that signed in through its connection.                                         |

## 3. Model

Two tables in the Control Plane. Identity provider settings and the client secret stay
in Logto, which already owns them for the deployment connector; the Control Plane
forwards a secret on save and does not keep it. The settings card reads the saved
settings back from Logto when an owner opens it, with the secret reported only by
whether one is stored.

```
org_sso_connection
  id, orgId (unique: one connection per organization)
  logtoConnectorId (unique), protocol: oidc | saml
  testNonceHash?, testExpiresAt?, testedAt?, activatedAt?, configChangedAt

org_domain
  id, orgId, domain (lowercase; unique among verified rows)
  challenge, challengeExpiresAt, verifiedAt?, lastCheckedAt?, lastCheckOk?

org
  memberSource: invite | domain (default invite)
```

A connection has no name of its own. An organization has one, so the console calls
it single sign-on, and a profile lists the identity it established as "SSO"
beside its address.

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

When organization SSO is on, the login page (`/login`) offers single sign-on as one
more method rather than asking every visitor for an address:

- The first three offered social providers are labeled buttons, followed by a
  "Continue with SSO" button. The remaining providers sit below an "or" divider as
  one row of icon buttons. With three or fewer providers there is no row, and a lone
  leftover becomes a labeled button rather than a single icon.
- "Continue with SSO" leads to the SSO page, `/login/sso`. It has a stable URL so
  that people who always sign in through their organization can bookmark it and skip
  the choice. Where organization SSO is off or sign-in is not configured, that URL
  sends the visitor to `/login`.
- The SSO page asks for a work email and posts it to an anonymous lookup, which
  answers with a connector to start (`{ connectorId }`) or nothing. With a connector,
  the page starts the same direct sign-in it uses for the deployment connector. With
  nothing, it says no single sign-on is set up for the address and links back to the
  other options. There is no password sign-in, so the field has no further step.
- The lookup decides by domain, never by whether the address has an account. It
  answers from an in-memory snapshot of the active domains, refreshed at most every
  fifteen seconds, so an anonymous request costs no query; limiting request volume
  is the ingress's job. It does reveal that a domain uses SSO; that is accepted.
- The browser remembers the last method that worked and marks it "Last used" in
  place, on its button, its icon, or "Continue with SSO" for an organization's
  connection; nothing moves. The SSO page prefills an address used last. The server
  is not asked.

The field is a convenience, not the control. Logto refuses password, code and social
sign-in for an address whose domain is bound to a connector, whatever the page shows.

A deployment with only a deployment connector keeps its single button.

### 4.3 Membership

An organization has one member source, which an owner sets on the settings card:

- `invite` (the default): new members arrive by invitation only.
- `domain`: an account whose address is on one of the organization's verified domains
  also becomes a member when it signs in. It needs a verified domain, and releasing
  the last one returns the organization to `invite`.

The member source is separate from the connection. An organization may take members by
domain with no connection, where its people sign in by the deployment's other
methods, and an organization with an active connection may stay on invitations.
Activating a connection changes how the domain's addresses sign in (§4.1), not who
is a member.

The address is the account's own at the identity service. It was proven when it was set:
a social provider reports only an address it has verified, a connection's address is
bounded by the verified domains (§5), and the deployment offers no sign-up by address
alone. Where a deployment lets an account change its address, the identity service asks
for proof of the new one. It is not proven again at each sign-in, so a person who has
left the company but still signs in with another linked identity joins like anyone else
on the domain; an owner removes them, and an organization that needs the identity
provider to decide enforces its connection (§4.5).

The join is its own step: the console calls `POST /sso/join` after a sign-in. It reads
the caller's address from the identity service and is idempotent on the join record.
It does not ride on the sign-in gate, which resolves a subject once per process and
so would miss an existing account's first sign-in after an owner chose `domain`.

- A caller with an address on a domain verified by an organization whose member source
  is `domain`, and no join record for that organization, gets a membership as
  `collaborator` (the role an invite link grants) and a join record. A domain is
  verified by one organization, so at most one organization answers. The join is
  audited.
- A caller who is already a member keeps their role and gets the join record.
- The join record outlives the membership. An owner who removes such a member is not
  overruled at the person's next sign-in; they can be invited back.
- The check runs at sign-in. Someone already signed in when an owner chooses `domain`
  joins at their next sign-in.
- Removing someone at the identity provider stops new sign-ins through the
  connection. On an enforced connection no new session then reaches the
  organization (§4.5), whatever other sign-in identities the account holds. On an
  active connection that is not enforced, an account that has also linked a social
  identity reporting another address still signs in with it and reaches the
  organization, and so does every member whose address is outside the domains. A
  session already signed in lasts until it ends, and the membership,
  API keys and OAuth grants stay. Ending those needs the provider to notify the
  deployment, which is out of scope here (§7).

**The deployment's connector.** Where the deployment owns the connector (D1, D6), the
same choice belongs to the connector, and its `domains` play the part of an
organization's verified domains: the operator who configures them owns the deployment,
so they are not verified by DNS. Setup's SSO form holds it as "New members", with
`domain` ("Anyone who signs in with SSO") the default and `invite` ("Invite only") the
other value; the document stores it as `logto.ssoConnector.memberSource`, and a
document without it reads as `domain`. The Control Plane reads it at startup, like the
rest of the connector.

- With `domain`, an account whose address is on one of the connector's domains
  (exactly, ignoring case, no subdomains) joins the deployment's organization as
  `collaborator`, through the same `POST /sso/join` and the same join record, so a
  removal stands and an existing member keeps their role.
- The deployment's organization is its only one. With no organization, or more than
  one, nobody joins, and the Control Plane says so in its log once per process start,
  without addresses. Organizations are counted as rows: deleting one removes its row.
- An account that joins is a member, so where the waitlist is on it passes the gate.
- The console shows the choice read-only on the organization's Members tab, marked as
  set by the deployment.

One place decides which source answers: the deployment's connector when the deployment
declares one, otherwise the organizations' own member sources. The two kinds exclude
each other (D1), so this chooses a source, never merges two.

Members pushed by the identity provider (§7) would be a third member source, chosen
instead of `domain` and never beside it: the provider's list and "anyone on the
domain" give different answers to who is a member.

### 4.4 Claiming an invited row

Unchanged for addresses outside any bound domain. For an address inside one, the
existing claim by email relies on §5: only that organization's connection can assert
the address.

### 4.5 Per session

The identity service refuses another sign-in method for an address in a bound
domain, but it judges the address that sign-in reports. An account holds several
sign-in identities, and a linked social identity may report another address or none,
so that refusal alone does not keep such an account out of the organization. An owner
who enforces the connection makes the organization require the connection of every
member, on every request:

- **Two steps.** Activating binds the domains and routes their addresses to the
  connection (§4.1). Enforcing is a separate owner action on an active connection,
  and stopping it leaves the connection active. The settings card offers "Enforce"
  beside "Deactivate" on an active connection, and "Stop enforcing" once the
  connection reads as enforced. The Enforce dialog lists the domains and says the
  rule covers every member, owners included, and that members whose address is not
  on these domains lose access; when the owner may not enforce yet, it says why instead: an
  owner outside the domains is told only such an owner can, with nothing to
  confirm, and an owner inside them who did not sign in through the connection is
  offered that sign-in, which returns to the card. `GET /sso` tells an owner which
  of these applies (`enforce`).
- **The rule.** Every request to an enforced organization, from any member whatever
  their address or role, must come from a browser session whose latest sign-in went
  through its connection. Otherwise it is refused with 403 `ORG_SSO_SIGN_IN_REQUIRED`.
  The account's other organizations are unaffected.
- **Members outside the domains.** The connection speaks only for addresses in the
  verified domains (§5), so a member whose address is elsewhere cannot meet the rule
  and loses access while it is enforced. A contractor keeps access by getting an
  address on the organization's domains at its identity provider; an organization
  that wants outside members unrestricted does not enforce.
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
  method belongs to a session, not a subject, so nothing caches it; whether the
  connector exists is cached for a minute.
- **Who configures it.** The Setup Server owns the script while organization SSO is
  declared, and reports a missing or different one as drift (§6.1). The script also
  carries the role names the Control Plane reads for `ADMIN`, so it replaces a
  script that did only that. Until it is applied no session carries the claim, and
  no owner can enforce.
- **The address is not the member's to change.** Who may enforce, who joins on a
  first sign-in (§4.3) and which accounts the sign-in check admits (§5) all read the
  account's address in the identity service. While organization SSO is declared,
  the Setup Server keeps the identity service's account-center permission for the
  address from being editable, reports an editable one as drift, and sets it to
  read-only on apply.
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
  stopping take effect within the lookup's fifteen seconds (§4.2). When the identity
  service cannot confirm the connector, the rule still applies.
- **The console.** `GET /orgs` returns, for each organization, `ssoSignIn` (the
  connector) when this session must first sign in through it. The
  console then shows, in place of the organization's pages, its name
  with one action, "Sign in with SSO", which starts the same
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
| `PUT /member-source`                | Choose how new members arrive (§4.3); `domain` needs a verified domain.                                                                               |
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
  The path keeps its name; the join no longer depends on a connection. It exists under
  both kinds of SSO: the deployment's connector or the organizations' member sources
  answers, whichever the deployment has.
- `POST /admin/orgs/:orgId/sso/connection/deactivate`,
  `POST /admin/orgs/:orgId/sso/connection/stop-enforcing` and
  `DELETE /admin/sso/domains/:id`: a deployment `ADMIN`'s recovery paths (§4.1, §4.5).
- `POST /sign-in/lookup`: anonymous (§4.2).

`/runtime-config` gains one boolean, `auth.organizationSso`, so the login page knows to
offer the SSO page.
`auth.sso` keeps describing the deployment connector, and `auth.ssoMemberSource`
carries its member source (`invite` or `domain`, null without a connector), never its
domains; the console calls `POST /sso/join` and shows the read-only card from it.

`GET /orgs` gains `ssoSignIn` per organization, and a refused request carries the
code `ORG_SSO_SIGN_IN_REQUIRED` (§4.5).

### 6.1 Two writers to Logto

The Control Plane becomes a second writer to Logto beside the Setup Server. Each owns
a disjoint part:

| Writer        | Owns                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup Server  | The sign-in experience, the one connector with its fixed name, and, while organization SSO is declared, the access-token claims script and the account center's address permission. |
| Control Plane | Connectors named after an organization: their configuration and their domains.                                                                                                      |

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
4. **Membership** (landed): the join record and `POST /sso/join`; then the member
   source, which took the join off the connection and put it on the verified domain.
5. **Web** (landed): the SSO page and its entry on the login page, the call to `POST /sso/join`
   after a sign-in, the settings card, and the page a test sign-in lands on.
6. **Per session** (landed): the access-token claims script and its drift check, the
   enforce step and the check of §4.5, `ssoSignIn` on `GET /orgs`, and the console's
   sign-in step for an organization, and the card's Enforce and Stop enforcing.
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
- With the member source on `domain`, a first sign-in with an address on a verified
  domain creates the membership, with or without a connection; removing the member
  and signing in again does not recreate it. On `invite` it creates none.
- Changing the configuration clears the test result and blocks activation.
- Deactivating restores social sign-in for the domain.
- An owner outside the domains cannot enforce. Once an owner inside the domains
  enforces, a member who signed in with a linked social identity is refused in the
  organization, reaches it after signing in through the connection, and keeps
  reaching their other organizations meanwhile; a member or owner outside the
  domains is refused too.

Open points:

- A periodic pass that applies the sign-in check of §5 to accounts that have not
  signed in yet, and deactivates a connection that keeps failing it.
- SAML has been read but not yet exercised end to end.
