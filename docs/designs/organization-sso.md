# Organization single sign-on

> **Status:** Proposal for review.
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

| #   | Decision                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | An SSO connection is owned by the deployment (today's connector, unchanged) or by one organization (new). Organization-owned connections exist only on a deployment that declares the guarantees of §5. |
| D2  | An organization proves it controls an email domain by a DNS record before it can use that domain. A domain belongs to at most one organization.                                                         |
| D3  | Binding a verified domain to a connection is what enforces SSO for that domain. There is no separate enforcement switch, and binding is refused until a sign-in through the connection has succeeded.   |
| D4  | The login page asks for an email address and routes by its domain. Social sign-in buttons stay on the same screen.                                                                                      |
| D5  | A person who first signs in through an organization's active connection becomes a member of that organization once.                                                                                     |
| D6  | A deployment that belongs to one company keeps the deployment connector and needs none of this: no domain verification, no lookup, no organization settings.                                            |

## 3. Model

Two tables in the Control Plane. Identity provider settings and the client secret stay
in Logto, which already owns them for the deployment connector; the Control Plane
forwards a secret on save and does not keep it.

```
org_sso_connection
  id, orgId (unique: one connection per organization)
  logtoConnectorId (unique), protocol: oidc | saml, name
  testNonceHash?, testedAt?, activatedAt?, configChangedAt

org_domain
  id, orgId, domain (lowercase; unique among verified rows)
  challenge, challengeExpiresAt, verifiedAt?, lastCheckedAt?, lastCheckOk?
```

Only a verified row holds a domain. Any organization may start a challenge for a
domain, so nobody can block one they do not control: a pending challenge expires, and
when one organization verifies the domain the pending rows of the others are dropped.

A connection is **draft** until `testedAt` is later than `configChangedAt`, **tested**
after that, and **active** once `activatedAt` is set.

A connection carries two lists in the identity service. The Control Plane is the only
writer of both.

- **Allowed domains**: the organization's verified domains, written whenever that set
  changes and before a sign-in through the connection can start. R1 (§5) is checked
  against this list, and an empty list refuses every sign-in.
- **Bound domains** (Logto's `domains`): written at activation and emptied at
  deactivation. This is the list Logto routes by and enforces.

A draft or deactivated connection therefore has allowed domains and no bound ones. It
can be tested, only with addresses the organization has proved it controls, and it
neither routes nor restricts anyone.

The rows are the desired state. A write to Logto follows the row and sets a whole
value, so a retry or a second Control Plane instance converges on the same result. If
the Logto connector is gone, after an identity service was rebuilt for instance, the
connection shows as needing its configuration again: the secret is not kept, so the
connector cannot be recreated on the owner's behalf.

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
   provider. "Test sign-in" needs a verified domain. It mints a one-time nonce and
   starts a sign-in directly against this connector. The landing page presents the
   nonce; the Control Plane marks the connection tested when the account that landed
   holds an identity on this connector. The nonce shows an owner started the test; the
   identity shows the provider works. Any change to the configuration clears the
   result.
3. **Activate.** Offered only when a domain is verified and the connection is tested.
   Activation resolves the DNS records again before it binds. From this moment
   addresses in those domains sign in only through the connection. A domain verified
   while the connection is active is bound when it is verified.

An organization-owned OIDC connection never trusts an unverified email; the
`trustUnverifiedEmail` option stays a deployment-connector setting.

Configuration changes, activation and deactivation are audited with their actor, owner
or `ADMIN`.

Deactivating empties the bound domains, which lifts the restriction; the allowed
domains stay. An owner can deactivate their own connection, and a deployment `ADMIN`
can deactivate any connection, which is the recovery path when an identity provider
breaks after activation.

### 4.2 Signing in

When organization SSO is on, the login page shows an email field above the social
buttons.

- The page posts the address to an anonymous lookup, which answers with a connector
  to start (`{ connectorId, name }`) or nothing.
- With a connector, the page starts the same direct sign-in it uses today for the
  deployment connector.
- With nothing, the page stays where it is and points at the social buttons. There is
  no password sign-in, so the field has no further step for such an address.
- The lookup decides by domain, never by whether the address has an account. It is
  rate limited. It does reveal that a domain uses SSO; that is accepted.
- The browser remembers the last method that worked and puts it first next time. The
  server is not asked.

The field is a convenience, not the control. Logto refuses password, code and social
sign-in for an address whose domain is bound to a connector, whatever the page shows.

A deployment with only a deployment connector keeps its single button.

### 4.3 Membership

The join is its own step when a sign-in resolves to a local user. It reads from the
identity service which connections the caller holds an SSO identity on, and it is
idempotent on the join record. It does not ride on the cached identity read the
sign-in gate makes.

- A caller with an identity on an organization's active connection, and no join
  record for that organization, gets a membership as `collaborator` (the role an
  invite link grants) and a join record. The join is audited.
- The join record outlives the membership. An owner who removes such a member is not
  overruled at the person's next sign-in; they can be invited back.
- Removing someone at the identity provider stops their sign-in through the
  connection, and so with a bound address. It is not an organization-wide rule: an
  account that has also linked a social identity reporting another address, or none,
  still signs in with it. Nor does it remove the membership or revoke API keys and
  OAuth grants. Both need the provider to notify the deployment, which is out of
  scope here (§7).

### 4.4 Claiming an invited row

Unchanged for addresses outside any bound domain. For an address inside one, the
existing claim by email relies on §5: only that organization's connection can assert
the address.

## 5. What the identity service must guarantee

An organization owner chooses the identity provider, so on a shared deployment the
provider is untrusted input. Organization-owned connections need two guarantees from
the identity service:

- **R1.** A connection can assert only addresses in its allowed domains (§3). With
  none, it can assert nothing.
- **R2.** An identity established through one connection is never accepted through
  another.

Both apply before any user is identified, so they cover sign-in, linking and
registration alike, and the test sign-in of §4.1 as much as any other. They are
opt-in at the identity service: a deployment connector may serve addresses outside
its listed domains today, and applying R1 to it unasked would lock those people out.

**Who provides them.** Stock Logto offers neither as a setting. They are a change to
Logto's enterprise SSO verification, to be contributed upstream. They cannot be
enforced in the Control Plane instead: by the time a token reaches it, the identity
service has already chosen the account.

- Until a Logto release includes the change, organization SSO needs a Logto build
  that carries it. Such a build reports the capability, and the Setup Server reads
  that before it lets an operator declare organization SSO (D1).
- A deployment on the stock image pinned in `compose.logto.yaml`, or on Logto Cloud,
  cannot report it. Organization SSO stays off there, and the deployment connector
  remains its SSO.

How the two are implemented and tested is specified with the change that adds them.

Domain ownership and uniqueness are the Control Plane's job. Logto does not verify
ownership and lets two connectors list the same domain; it only refuses a list of
public mail domains.

## 6. API

Under `/orgs/:orgId/sso`, owner-only and `interactiveOnly` (they manage how an
organization's people authenticate, and one of them carries a client secret):

| Route                         | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `GET /`                       | Domains, connection state, the service-provider values to show. |
| `POST /domains`               | Add a domain; returns the challenge.                            |
| `POST /domains/:id/verify`    | Resolve the TXT record now.                                     |
| `DELETE /domains/:id`         | Release a domain; an owner is refused while it is bound.        |
| `PUT /connection`             | Create or update the connection; clears the test result.        |
| `POST /connection/test`       | Mint the test nonce; refused without a verified domain.         |
| `POST /connection/activate`   | Bind verified domains.                                          |
| `POST /connection/deactivate` | Unbind. Also allowed for a deployment `ADMIN`.                  |

A deployment `ADMIN` may also release any domain, bound or not; releasing a bound one
unbinds it first.

Outside the organization subtree: `POST /sign-in/lookup` (anonymous, rate limited) and
`POST /sso/test-result` (any signed-in caller, presents the nonce).

`/runtime-config` gains one boolean so the login page knows to show the email field.
`auth.sso` keeps describing the deployment connector.

### 6.1 Two writers to Logto

The Control Plane becomes a second writer to Logto beside the Setup Server. Each owns
a disjoint part:

| Writer        | Owns                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Setup Server  | The sign-in experience, and the one connector with its fixed name.                              |
| Control Plane | Connectors named after an organization: their configuration, allowed domains and bound domains. |

The Setup Server's desired value for Logto's `singleSignOnEnabled` becomes "a
deployment connector exists, or organization SSO is declared". Without that, its next
reconcile would switch single sign-on off for every organization. Its inspection
leaves connectors it does not own out of the drift report.

The Control Plane already holds a Logto Management API client. The calls that create
and update a connector exist in the Setup Server for the deployment connector; with a
second caller they move to where both can use them.

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
  deployment `ADMIN` can always deactivate.
- **A test sign-in can land on a different account** when the provider's address
  differs from the owner's. R1 holds for it, so that account can only be one whose
  address is in a domain the organization has verified. The connection is still
  marked tested; the owner signs back in. The settings card says so before starting.

## 9. Rollout and verification

Each step merges on its own.

1. **The guarantees of §5** in the identity service, with tests. Reviewed separately
   from everything else.
2. **Control Plane and Setup Server:** the two tables, DNS verification, connection
   management against Logto, the lookup, and the ownership rule of §6.1. This step
   adds the feature's entry to `.oss-scanner/threat_model.md`.
3. **Web:** the email field on the login page; the settings card.
4. **Membership** on first sign-in, with the join record.
5. **User documentation**, once the feature is complete.

Verification on a staging deployment with a real identity provider, OIDC and SAML:

- A second organization cannot verify a domain the first has verified, and an
  unverified claim blocks nobody.
- R1 and R2 hold for both protocols.
- A draft connection cannot sign in an address outside the organization's verified
  domains, and the test is refused when there is none.
- A Setup Server reconcile leaves single sign-on on and reports no drift for
  organization connectors.
- After activation: social sign-in with a bound address is refused; the email field
  routes it to the provider; an existing social account with that address arrives as
  the same user.
- A first sign-in creates the membership; removing the member and signing in again
  does not recreate it.
- Changing the configuration clears the test result and blocks activation.
- Deactivating restores social sign-in for the domain.

Open points to settle during step 1 and 2:

- Whether Logto accepts a direct sign-in against a connector that has allowed domains
  but no bound ones yet. The test in §4.1 depends on it.
- The form of the capability a Logto build reports for §5, which the Setup Server
  reads.
