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
  id, orgId, domain (unique, lowercase)
  challenge, verifiedAt?, lastCheckedAt?, lastCheckOk?
```

A connection is **draft** until `testedAt` is later than `configChangedAt`, **tested**
after that, and **active** once `activatedAt` is set. Activation writes the
organization's verified domains to the Logto connector's `domains`; nothing else ever
writes them. Until then the connector carries no domains, so Logto neither routes to it
nor restricts anyone.

The Logto connector is named after the organization id. `connectorName` is unique in
Logto, and the Setup-managed connector keeps its fixed name, so the two never collide.

## 4. Flows

### 4.1 Setting up (organization owner)

One card in organization settings, three steps in order:

1. **Add a domain and verify it.** The card shows a TXT record to create at
   `_agentconnect-challenge.<domain>`. "Verify" resolves it from the Control Plane. A
   domain another organization holds is refused.
2. **Configure the connection and test it.** OIDC takes issuer, client id, client
   secret and scopes; SAML takes a metadata URL or document and an attribute mapping.
   The card shows the callback URL, ACS URL and entity id to enter at the identity
   provider. "Test sign-in" mints a one-time nonce and starts a sign-in directly
   against this connector. The landing page presents the nonce; the Control Plane
   marks the connection tested when the account that landed holds an identity on this
   connector. The nonce shows an owner started the test; the identity shows the
   provider works. Any change to the configuration clears the result.
3. **Activate.** Offered only when a domain is verified and the connection is tested.
   From this moment addresses in those domains sign in only through the connection.

An organization-owned OIDC connection never trusts an unverified email; the
`trustUnverifiedEmail` option stays a deployment-connector setting.

Deactivating removes the domains from the Logto connector, which lifts the
restriction. An owner can deactivate their own connection, and a deployment `ADMIN`
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

The Control Plane already reads a caller's Logto identities at admission. That read
now also yields the connectors the caller holds an SSO identity on.

- A caller with an identity on an organization's active connection, and no join
  record for that organization, gets a membership as `collaborator` (the role an
  invite link grants) and a join record. The join is audited.
- The join record outlives the membership. An owner who removes such a member is not
  overruled at the person's next sign-in; they can be invited back.
- Removing someone at the identity provider stops their sign-in. It does not remove
  the membership or revoke API keys and OAuth grants. That needs the provider to
  notify the deployment, which is out of scope here (§7).

### 4.4 Claiming an invited row

Unchanged for addresses outside any bound domain. For an address inside one, the
existing claim by email relies on §5: only that organization's connection can assert
the address.

## 5. What the identity service must guarantee

An organization owner chooses the identity provider, so on a shared deployment the
provider is untrusted input. Organization-owned connections need two guarantees from
the identity service:

- **R1.** A connection can assert only addresses in the domains bound to it.
- **R2.** An identity established through one connection is never accepted through
  another.

Both apply before any user is identified, so they cover sign-in, linking and
registration alike. They are opt-in at the identity service: a deployment connector
may serve addresses outside its listed domains today, and applying R1 to it unasked
would lock those people out.

Organization SSO is off unless the operator declares in the deployment document that
the identity service provides both (D1). How they are implemented and tested is
specified with the change that adds them.

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
| `DELETE /domains/:id`         | Release a domain; refused while it is bound.                    |
| `PUT /connection`             | Create or update the connection; clears the test result.        |
| `POST /connection/test`       | Mint the test nonce.                                            |
| `POST /connection/activate`   | Bind verified domains.                                          |
| `POST /connection/deactivate` | Unbind. Also allowed for a deployment `ADMIN`.                  |

Outside the organization subtree: `POST /sign-in/lookup` (anonymous, rate limited) and
`POST /sso/test-result` (any signed-in caller, presents the nonce).

`/runtime-config` gains one boolean so the login page knows to show the email field.
`auth.sso` keeps describing the deployment connector.

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
  differs from the owner's. The connection is still marked tested; the owner signs
  back in. The settings card says so before starting.

## 9. Rollout and verification

Each step merges on its own.

1. **The guarantees of §5** in the identity service, with tests. Reviewed separately
   from everything else.
2. **Control Plane:** the two tables, DNS verification, connection management against
   Logto, the lookup.
3. **Web:** the email field on the login page; the settings card.
4. **Membership** on first sign-in, with the join record.
5. **User documentation**, once the feature is complete.

Verification on a staging deployment with a real identity provider, OIDC and SAML:

- A second organization cannot add a domain the first holds.
- R1 and R2 hold for both protocols.
- After activation: social sign-in with a bound address is refused; the email field
  routes it to the provider; an existing social account with that address arrives as
  the same user.
- A first sign-in creates the membership; removing the member and signing in again
  does not recreate it.
- Changing the configuration clears the test result and blocks activation.
- Deactivating restores social sign-in for the domain.

Open points to settle during step 1 and 2:

- Whether Logto accepts a direct sign-in against a connector that has no domains yet.
  The test in §4.1 depends on it.
- How the Setup Server confirms the guarantees of §5 before letting an operator turn
  organization SSO on, rather than taking the operator's word.
