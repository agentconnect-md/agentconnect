# Daemon API Key Authentication

**Status:** Implemented

**Owner:** AgentConnect team

Daemon-to-Control-Plane authentication uses a long-lived, database-backed,
revocable API key in the WebSocket `auth` frame. The same credential primitive
also supports personal, relay, and OAuth access tokens, while each principal
type remains confined to its intended trust boundary.

In-cluster daemons do not use this credential. A cloud daemon authenticates with
the projected ServiceAccount token its pod carries, verified by TokenReview —
see "Identity is per Pod, not per org" in
[k8s-daemon-pool.md](k8s-daemon-pool.md). A cloud daemon could not use a key
even in principle: it serves every org, and a daemon key is bound to one.

Companion references:

- [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) for the WebSocket
  handshake and close-code contract.
- [daemon-detailed-design.md](daemon-detailed-design.md) for daemon
  configuration and CLI behavior.
- [shared-bot-relay.md](shared-bot-relay.md) for relay authentication.
- [agent-assistant.md](agent-assistant.md) for OAuth access tokens.

---

## 1. Security properties

- The credential is an opaque bearer token and is sent only in the TLS-protected
  `auth` frame body. It is never placed in a URL query parameter.
- The Control Plane stores only
  `HMAC-SHA256(secret, API_KEY_PEPPER)`, never the plaintext secret.
- The required `API_KEY_PEPPER` is at least 32 characters and must be shared by
  every Control Plane replica.
- The plaintext key is returned exactly once when minted. Subsequent reads
  expose only metadata and a non-secret `displayTail`.
- Revocation and expiry are checked on every authentication attempt.
- A daemon key is bound to one daemon and one organization. A key for a user,
  relay, or OAuth principal cannot authenticate the daemon WebSocket.
- Successful daemon authentication advances the daemon's monotonic
  `sessionEpoch`; failed authentication does not.

Rotating `API_KEY_PEPPER` invalidates every stored hash. Safe pepper rotation
therefore requires a versioned-pepper migration; until that exists, treat the
configured pepper as immutable.

---

## 2. Key format and storage

Minted keys use this opaque form:

```text
<secret><crc>
```

- `secret` is 43 base62 characters generated from 32 bytes of CSPRNG entropy.
- `crc` is a six-character base62 encoding of CRC32 over `secret`.
- The checksum is only an offline typo guard; it is not an authentication
  primitive.
- The token contains no principal type, key id, organization, or other
  identifying prefix.

Documentation, tests, logs, and examples must use a placeholder such as
`<generated-key>`, not a key-shaped sample.

The codec validates the base62 shape and checksum before querying storage. It
then computes the peppered HMAC and performs a unique indexed lookup by `hash`.
A fast keyed hash is appropriate because the input is high-entropy random data;
a password hash would add handshake cost without improving resistance to
guessing.

The persisted `ApiKey` row contains:

- `principalType`: `daemon`, `user`, `relay`, or `oauth`.
- Optional bindings for `orgId`, `daemonId`, `userId`, and `oauthGrantId`.
- `hash`, `displayTail`, optional `name`, scopes, and audit attribution.
- Creation, last-use, expiry, and revocation timestamps.

`ApiKey.daemonId` has a cascading foreign key to `Daemon`, so deleting a daemon
also removes its credentials. Relay keys are infrastructure principals and are
not organization-bound. The schema in
`packages/control-plane/prisma/schema.prisma` is authoritative.

---

## 3. Daemon authentication

The daemon sends:

```json
{
  "v": 1,
  "id": "<uuid>",
  "ts": "<RFC3339 timestamp>",
  "type": "auth",
  "payload": {
    "apiKey": "<generated-key>",
    "agentVersion": "<version>"
  }
}
```

`daemonId`, `machineId`, attestation, and resume information are optional
handshake fields governed by the protocol schema. When `daemonId` is present,
it must match the daemon bound to the key.

The Control Plane authenticates in this order:

1. Parse and checksum-validate the key without a database call.
2. Look up the row by the peppered HMAC.
3. Reject a missing, revoked, expired, unbound, organization-less, or
   non-`daemon` row.
4. Reject an echoed `daemonId` that does not match the bound daemon.
5. Advance `sessionEpoch`, record the authenticating key id as `tokenFp`, and
   return `auth/ok`.
6. Best-effort update `lastUsedAt`.

Credential failures close the socket with `4401 AUTH_FAILED`. Storage or epoch
update failures close it with `1011 SERVER_INTERNAL`, allowing the daemon to
back off and retry a transient failure. Authentication failures do not mutate
the daemon epoch.

`auth/ok` returns the authoritative `daemonId`, the new `sessionEpoch`,
heartbeat configuration, server time, and optional console-link metadata. A
daemon adopts the returned identity.

---

## 4. Provisioning and daemon lifecycle

Provisioning creates the parent daemon row before its first key so the foreign
key is valid:

1. Create a UUID daemon in `provisioned` state with `sessionEpoch = 0`.
2. Mint a `daemon` key bound to that daemon and organization.
3. Persist only the key hash and metadata with `expiresAt = null`.
4. Return `{ daemonId, apiKey, displayTail, command }`, where `apiKey` appears
   only in this response.

The generated command uses:

```text
npx -y @agentconnect.md/daemon run --api-url <control-plane-websocket-url> --api-key <generated-key>
```

The daemon stores the key in `controlPlane.key`; `--api-key` is the connect
override. `AuthReq.apiKey` is the only daemon credential field.

Daemon keys currently have no fixed expiry or idle reaper. They remain valid
until one of these events:

- an operator revokes the key;
- the bound daemon is deleted, which cascades to its keys; or
- a future explicit expiry is set on the row.

The Control Plane does not emit a `key-reaped` state. Any UI handling of that
string is defensive compatibility behavior, not an active lifecycle.

---

## 5. Rotation, listing, and revocation

Daemon-key management inherits the visibility and edit permissions of the
parent daemon. These routes, like `POST /daemons/token` and
`POST /agents?connect=true`, take an interactive sign-in only (§6):

| Endpoint                          | Behavior                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `GET /daemons/:id/keys`           | Lists key metadata without plaintext or hashes.                             |
| `POST /daemons/:id/keys`          | Mints an additional key for the same daemon and returns the plaintext once. |
| `DELETE /daemons/:id/keys/:keyId` | Revokes a key owned by that daemon.                                         |

Multiple active keys per daemon are allowed for overlap rotation:

1. Mint a new key.
2. update the daemon configuration and reconnect.
3. Confirm the new credential is in use.
4. Revoke the old key.

Minting or revoking a key does not directly change `sessionEpoch`; the next
successful authentication advances it through the normal handshake path.

Revocation prevents the next authentication attempt immediately. The revoke
route also tells relays to drop the revoked daemon's relay reach. An
already-established direct daemon-to-Control-Plane WebSocket is not currently
closed by the revoke route, so urgent live-session termination also requires
the applicable drain or connection-control operation.

Audit events record the actor, daemon id, key row id, display tail, and reason.
They never include the plaintext key or stored hash.

---

## 6. Personal, relay, and OAuth keys

The principal type is stored only in the database row. The opaque token format
is shared, but authentication services enforce strict separation.

### Personal keys

`GET`, `POST`, and `DELETE /me/keys` let a user list, mint, and revoke their own
organization-bound keys; `PATCH /me/keys/:id` edits one in place and
`POST /me/keys/:id/regenerate` replaces its secret (both below, under
[Key permissions and agent selection](#key-permissions-and-agent-selection)).

- A key acts as its bound user in its bound organization.
- The default expiry is 90 days; callers may request a non-expiring key.
- A request authenticated by a personal key cannot mint another personal key.
- A request authenticated by a personal key cannot create or delete an
  organization, cannot list, edit, regenerate, or revoke personal keys, and
  cannot list, issue, or revoke daemon keys or provision a daemon (§5). These
  routes, and OAuth consent and grant management, set
  `interactiveOnly` in their Fastify route config. `humanAuth` refuses any API
  key, OAuth access token, or delegated invocation on them with 403
  `interactive sign-in required`, and the OpenAPI document leaves them out. A
  browser sign-in, or the no-auth local mode, is unaffected.
- Human authentication resolves the key to `userId`, `orgId`, and scopes, then
  normal authorization applies.
- A personal key cannot authenticate the daemon WebSocket.

### Relay keys

Relay keys use `principalType = relay`, have no organization or daemon binding,
and authenticate only relay control paths. Daemon and human authentication
reject them.

### OAuth access tokens

OAuth access tokens use `principalType = oauth`, are bound to a user,
organization, scopes, and an OAuth grant, and have a finite expiry. Revoking an
OAuth grant revokes its access-token rows.

### Key permissions and agent selection

**Status:** Implemented. The agent chat API in
[shared-bot-relay.md §10.4](shared-bot-relay.md#104-agent-chat-api) is the
first consumer.

A personal key today carries its user's whole role. A server that an
organization runs, such as a documentation site's backend, needs a key that can
do one thing with one agent. The model follows a GitHub App installation: a
permission set and a resource selection, on the credential rather than on the
person. There is no separate principal type for it. The same two columns
describe every key that human authentication admits, so a service-account
member's key ([below](#service-account-members)) differs from a personal key
only in whose identity it carries.

- `ApiKey.permission` is one of `full`, `read`, or `agent:chat`. `full` is the
  default and is today's behavior. `read` admits only `GET`, `HEAD`, and
  `OPTIONS`. `agent:chat` admits only routes that declare it. The existing
  `scopes` column keeps its OAuth meaning and is not reused.
- Agent selection is `ApiKey.allAgents` plus an `ApiKeyAgent` join table whose
  rows cascade when the agent is deleted. It applies only to agent-level
  permissions, `agent:chat` in v1; `full` and `read` always cover every agent.
  A key with `allAgents = false` and no rows reaches no agent. An empty
  selection never means all.
- Enforcement lives in one place, `humanAuth`, and depends on the permission.
  `full` is admitted everywhere. `read` is admitted by every route whose method
  is `GET`, `HEAD`, or `OPTIONS` and refused by every other; that is the
  read-only check the org-scope guard applies to OAuth tokens today, moved to
  where the key is resolved so it also covers `/me/*` and MCP. The one
  exception is a route that declares `read` through its Fastify route config,
  which says it gates its own writes: the MCP endpoint, a `POST`, declares it,
  admits a `read` key, and hides and refuses its write tools for that key
  exactly as it does for an `mcp:read` token. An agent-level permission is
  admitted only by a route that declares it through the same route config, so
  every undeclared route, including `/me/*`, the MCP endpoint, and any route
  added later, refuses it. When the declaring route carries an `:agentId`
  parameter, `humanAuth` also checks the key's selection and answers 404 for an
  agent outside it.
- The only v1 route that declares `agent:chat` is
  `POST /orgs/:orgId/agents/:agentId/webchat/token`. On a resume, the
  conversation's bound agent must also be in the selection.
- A token minted by a key inherits the key's limits. When the minting key's
  permission is not `full`, the token route stamps the permission and the agent
  into the token's claims, `rc/verify` returns them, and the relay enforces them
  at every entry point ([shared-bot-relay.md §10.4](shared-bot-relay.md#104-agent-chat-api)).
  A console mint, or a `full` key's, carries no such claim. Minting another
  token does not widen anything, since every token the key mints carries the
  same claims.
- `POST /me/keys` takes `permission` and, for an agent-level permission,
  `agents: 'all' | string[]`, required then and refused with 400 for `full`
  and `read`, which cover every agent; an id that is not a visible agent of
  the key's organization answers 404. The console's personal key dialog shows
  the two choices. The rest of the mint policy is unchanged: a 90-day default expiry,
  an optional non-expiring key, and a plaintext value shown exactly once.
- After minting, a key is edited and regenerated the way a GitHub fine-grained
  token is. `PATCH /me/keys/:id` changes `name`, `expiresInDays` (the mint
  body's shape: a new lifetime from now, or `null`), `permission`, and for an
  agent-level permission `agents`, with the mint's validation, judged against
  the permission the key has after the edit: entering `agent:chat` requires
  `agents`, `full` and `read` refuse it and clear the selection. The hash never
  changes, so the key keeps working with the same plaintext, and the org is
  fixed. `POST /me/keys/:id/regenerate` is the only way to get a new value: it
  writes a new hash and display tail on the same row, keeps every setting,
  resets `lastUsedAt`, answers the plaintext exactly once, and the previous
  value stops verifying at once. Neither call is admitted to a request
  authenticated by an API key, for the reason minting is not, and a revoked key
  answers 409 to both. `GET /me/keys` names the selected agents (`agents`, id
  and name) beside their ids; a deleted agent's row is already gone. Edits
  audit as `api_key_update`, regeneration as `api_key_rotate`.
- Nothing changes for the key's identity. It still acts as its user in its
  organization, and a session it opens is that user's session.

Tests should cover:

- a `read` key admitted on `GET /orgs/:orgId/agents` and refused on a write,
  including `POST /me/keys` and an MCP write tool;
- an `agent:chat` key admitted by the token route and refused on every
  undeclared route, including a `GET`, `/me/keys`, and MCP;
- 404 from the token route for an agent outside the selection, and for a
  resume whose conversation is bound to such an agent;
- the token minted by an `agent:chat` key carrying the permission and agent
  claims, and a console-minted token carrying neither;
- `full` keys ignoring the selection, and a selection emptied by agent deletion
  reaching no agent;
- existing rows defaulting to `full` after the migration.

### Service-account members

**Status:** Proposed.

A personal key belongs to a person and stops working when that person leaves
the organization. A server that the organization runs needs a credential that
belongs to the organization. The model follows GitLab's service accounts: a
user who cannot sign in, a member of the organization with a role, and keys
that an owner mints for it. There is no new principal type. A service
account's key is a personal key whose user is the service account, so
`humanAuth`, `permission`, agent selection, token claims, edit, and regenerate
apply to it unchanged.

| GitLab                             | AgentConnect                                         |
| ---------------------------------- | ---------------------------------------------------- |
| `User.user_type = service_account` | `User.kind`, `human` by default or `service_account` |
| Created by a group Owner           | Created by an organization owner                     |
| A group member with a role         | A member whose role is `collaborator` or `viewer`    |
| Owners create and revoke its PATs  | Owners mint, edit, regenerate, and revoke its keys   |
| Cannot sign in                     | Cannot sign in                                       |
| Deleting it removes its tokens     | Deleting it removes its keys                         |

The role is the one departure. GitLab allows any role; here a service account
is never `owner`, so the last-owner check and the choice of a repair member
([resource-visibility.md §8](resource-visibility.md#8-member-removal-and-audience-repair))
never have to exclude it.

- **Identity.** A service account is an `app_user` row with
  `kind = service_account`, no `oidcSubject`, and the email
  `<name>-<id>@sa.agentconnect.md`, where `name` is what its owner calls it at
  creation, and `id` is its random `app_user` id, which makes the address unique
  without any naming rule beyond lowercase letters, digits, and hyphens. As
  with Google's service accounts, the address never changes, so `name` is fixed
  once created. The display name starts as `name` and can be edited. The
  project serves no mail on that domain, so no identity provider can verify
  the address, but the claims below still check `kind`. It has exactly one
  membership, created with it. An invited member's row also has no
  `oidcSubject`, and two paths claim such a row by verified email: a first
  sign-in, and a later sign-in that upgrades a synthetic email and merges the
  row into the signed-in user (`upgradeSyntheticEmail`). Both claims, in their
  initial lookup and their locked recheck, and `POST /members`, which adds a
  member by email, skip or refuse a `service_account` row, so no one can sign
  in as a service account, absorb it, or add it to a second organization.
- **Routes.** `GET` and `POST /orgs/:orgId/service-accounts`, and `PATCH` and
  `DELETE /orgs/:orgId/service-accounts/:id`: create takes `name` and `role`,
  and edit changes the display name and `role`. Its keys live under `/orgs/:orgId/service-accounts/:id/keys`: list,
  mint, `PATCH`, `regenerate`, and revoke, with the body, validation, expiry
  policy, and one-time plaintext of `/me/keys`. `createdByUserId` records the
  owner who minted a key. Every one of these routes is owner-only and sets
  `interactiveOnly`, like `/me/keys`.
- **Membership.** `GET /members` omits service accounts; the console lists
  them on their own. The member routes answer 404 for a service account,
  including its own self-removal, so its membership changes only through the
  routes above. `POST /orgs` is already `interactiveOnly`, so a service account
  never creates, and so never owns, another organization.
- **Sessions.** A service account's sessions are visible to the organization:
  a webchat conversation it owns, and a Web API launch it makes, classify as
  `org` with no owner
  ([session-visibility.md §4.2](session-visibility.md#42-default-rules)).
- **Deletion.** `DELETE` runs managed member removal with the acting owner as
  the repair member, then deletes the `app_user` row in the same transaction.
  Its keys and webchat conversations cascade with the row. Its sessions stay,
  since they are already visible to the organization.
- **Console.** Settings gains an owner-only Service accounts section: the list,
  a create dialog with name and role, and each account's keys in the personal
  key dialog.

Not in v1: a disabled state, seat accounting, and a distinct audit actor type.
An audit row names a service account the way it names any user.

Tests should cover:

- a service account's `full` key admitted on an org route, and refused on
  `POST /orgs`, `/me/keys`, and every service-account route;
- a first sign-in, and a synthetic-email upgrade, whose verified email equals a
  service account's not claiming or merging it, and `POST /members` refusing
  that email;
- `owner` refused as a service account's role, and the member routes answering
  404 for it;
- a webchat conversation owned by a service account classifying as `org`;
- deletion revoking its keys and repairing an audience it alone held.

---

## 7. Scope attestation remains separate

The daemon API key authenticates the long-lived control channel. `machineId`
and scope attestation are separate protocol fields for narrowly scoped derived
authorization.

The root API key must not be passed to data-plane workers or resource servers.
Any future scope-attestation flow must exchange it at the Control Plane for a
short-lived, audience-bound capability.

---

## 8. Validation requirements

Tests should cover:

- mint/parse round trips and checksum rejection;
- valid authentication and monotonic epoch advancement;
- malformed, unknown, revoked, expired, wrong-principal, unbound, and
  wrong-daemon keys returning `4401` without an epoch write;
- storage and epoch failures returning `1011`;
- overlap rotation without epoch reset;
- one-time plaintext responses and metadata-only list responses;
- daemon-key ownership and organization isolation;
- personal-key organization binding, expiry, and self-propagation prevention;
- deletion of a daemon cascading to its key rows.

Secret-bearing fields and command-line arguments must be structurally redacted
at logging and tracing boundaries because the token deliberately has no
recognizable prefix.
