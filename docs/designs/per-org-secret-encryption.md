# Per-Org Secret Encryption and Crypto-Shredding

> Status: Proposed. Extends
> [`secret-store-seams.md`](./secret-store-seams.md), which established the
> single `SecretCipher` seam and the Vault Transit implementation. This document
> adds a **scope** to that seam so each organization's secrets are encrypted
> under its own key, and defines what organization deletion does with that key.

## 1. Background

Every persisted tenant secret already passes through one `SecretCipher`
(`secrets/cipher.ts`), and `VaultTransitSecretCipher` encrypts it under a single
transit key named by `VAULT_TRANSIT_KEY`. Two properties follow from that key
being deployment-wide:

- **One key protects every tenant.** Compromise or misuse of that key is
  deployment-wide, and there is no cryptographic boundary between organizations
  in a shared deployment.
- **Deleting an organization does not destroy its secrets.** Deletion removes
  rows, but any database backup taken before the deletion still decrypts in
  full. A deletion promise that depends on backup retention hygiene is not one
  that can be stated precisely to a customer.

This design gives each organization its own transit key, so deleting the
organization can destroy that key and render every ciphertext it ever produced —
**including the copies inside older backups** — permanently unreadable. That
operation is _crypto-shredding_.

**Non-goals.** The C5 lease broker track (`SecretsBroker` / `secret_lease`) is
untouched; it never handles plaintext. Per-user shredding is out of scope — the
key granularity is the organization. Postgres row-level security is a separate,
complementary layer.

## 2. Decisions

1. **Scope is an explicit parameter on both `seal` and `open`. It is never
   encoded in the stored value.**

   The alternative — writing the organization id into the ciphertext envelope so
   that `open` can select the key by reading it — is rejected. The stored string
   comes from the database, which is precisely the surface this program assumes
   may be read across tenants (a missing `orgId` filter, a wrong join, a new
   route that forgets a check). A self-describing envelope means a row belonging
   to organization A, handed to code serving organization B, **decrypts
   successfully and silently**. With an out-of-band scope, the caller asserts
   which tenant it believes the value belongs to, and a mismatch fails at Vault.

   This is the encryption-context discipline used by KMS-style APIs: decryption
   _asserts_ the context rather than _reading_ it. It is a defense-in-depth
   layer, not a substitute for org-scoped queries — it catches "fetched the
   wrong row", not "computed the wrong tenant".

2. **The stored value carries a format version tag, never a tenant identity.**
   `acv1:` marks the current envelope. It exists so the envelope can evolve, and
   so pre-migration values remain distinguishable; it says nothing about who
   owns the value.

3. **Scope kind is a static property of each store, not a runtime branch.**
   `DeploymentConfigStore` binds the constant deployment scope. Every other
   secret store binds the org scope of the resource it serves. No code path ever
   decides at runtime which _kind_ of scope a table uses.

4. **One transit key per organization**, named `<org-prefix><orgId>`, with the
   deployment key keeping its existing `VAULT_TRANSIT_KEY` name. Transit's
   derived-key `context` parameter was considered and rejected: derivation still
   has one root key, so there is nothing to destroy and no shred.

5. **Secret-store ports become org-scoped** (§5). This is what makes decision 1
   implementable: a port that accepts only a child id cannot assert a tenant.

6. **Crypto-shredding is a reconciler, not a transactional side effect** (§6).
   Deleting a Vault key is a remote effect that cannot join the Postgres
   transaction that deletes the organization.

## 3. Which scope a secret gets

The governing rule:

> **Ownership follows whom the credential acts for, not who issued it.**

A bot token obtained through a deployment-owned platform app, on behalf of one
organization, is that organization's secret. The platform app's own client
secret is the deployment's. The first is exactly the kind of value a customer
expects to be destroyed on deletion.

| Table                               | Seam                                  | Scope                           |
| ----------------------------------- | ------------------------------------- | ------------------------------- |
| `deployment_secret`                 | `DeploymentConfigStore`               | deployment (constant)           |
| `bot_secret`                        | `BotSecretStore`                      | org, one hop via `Bot`          |
| `agent_secret`                      | `AgentSecretStore`                    | org, one hop via `Agent`        |
| `hook_secret`                       | `HookSecretStore`                     | org, one hop via `HookDef`      |
| `mcp_provider_secret`               | `McpProviderSecretStore`              | org, one hop via `McpProvider`  |
| `mcp_grant.key`                     | `McpGrantRepo`                        | org, one hop via `McpProvider`  |
| `organization_environment_secret`   | `OrganizationEnvironmentSecretStore`  | org, one hop via the entry      |
| `external_memory_connection_secret` | `ExternalMemoryConnectionSecretStore` | org, one hop via the connection |
| `external_memory_grant.key`         | `ExternalMemoryGrantRepo`             | org, one hop via the connection |
| `slack_install`                     | `SlackInstallStore`                   | org, on the row                 |
| `slack_user_config`                 | `SlackUserConfigStore`                | org, on the row                 |
| `feishu_app_registration`           | `FeishuAppRegistrationStore`          | org, on the row                 |

No secret-bearing table is more than one foreign key from an organization.

**The invariant that makes shredding true:** no org-owned value may ever be
sealed under the deployment scope. A single such value turns that organization's
shred into a false claim, silently. §8 pins this with a test.

## 4. `SecretCipher` contract

```ts
export type SecretScope = { kind: 'deployment' } | { kind: 'org'; orgId: OrgId }

export interface SecretCipher {
  seal(plaintext: string, scope: SecretScope): Promise<string>
  open(stored: string, scope: SecretScope): Promise<string>
}
```

`seal` always emits the current envelope:

```
acv1:vault:v<key-version>:<base64>
└──┬─┘ └──────────┬─────────────┘
 envelope     transit ciphertext, self-describing key version
 version      (opaque; nonce + AES-256-GCM ciphertext + tag)
```

`open` has exactly three arms, in order:

| Stored value starts with | Behaviour                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- |
| `acv1:`                  | strip, decrypt the remainder under `scope`'s key                                  |
| `vault:v`                | legacy single-key value — decrypt under the deployment key, ignoring `scope` (§7) |
| anything else            | never sealed — return unchanged (existing contract)                               |

Key names:

| Scope                 | Key name                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `{kind:'deployment'}` | `VAULT_TRANSIT_KEY` (default `agentconnect-cp`)                             |
| `{kind:'org', orgId}` | `VAULT_TRANSIT_ORG_KEY_PREFIX + orgId` (default prefix `agentconnect-org-`) |

Org keys are created lazily: Transit creates a key on first `encrypt` when the
token carries `create` on that path, so no provisioning step is coupled to
organization creation.

**Boot assertion.** `VAULT_TRANSIT_KEY` must not begin with
`VAULT_TRANSIT_ORG_KEY_PREFIX`. Without it, a deployment key named inside the
org namespace would be deleted by the shred reconciler (§6) — an unrecoverable
loss of the deployment's entire trust root. `loadConfig` refuses to start.

The existing discipline is unchanged: arguments and response bodies are never
logged, `open` results stay cached by ciphertext (the cache key already includes
the envelope, so it remains correct across scopes), and `seal` is never cached.

## 5. Port changes

The scope must come from the caller, so ports that accept only a child id cannot
supply it. Resolving the organization inside the repository — joining to the
parent row and reading its `orgId` — is **not** an acceptable substitute: it is
still the data choosing its own key, which is the failure mode §2.1 exists to
prevent.

Ten ports take an `orgId` as their first parameter, matching the shape
`SlackUserConfigStore` and `McpProviderRepo` already use:

| Port                                  | Change                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| `BotSecretStore`                      | `put/get/delete(orgId, botId, …)`                       |
| `AgentSecretStore`                    | `merge/get(orgId, agentId, …)`, `keys(orgId, agentIds)` |
| `HookSecretStore`                     | `put/get/delete(orgId, hookId, …)`                      |
| `McpProviderSecretStore`              | `put/get/delete(orgId, providerId, …)`                  |
| `McpGrantRepo`                        | `mintFor/activeForProvider(orgId, providerId)`          |
| `SlackInstallStore`                   | `get/setBotToken/delete(orgId, id, …)`                  |
| `OrganizationEnvironmentSecretStore`  | `seal(orgId, value)`, `values(orgId, entryIds)`         |
| `ExternalMemoryConnectionSecretStore` | `put/get/keys/delete(orgId, connectionId, …)`           |
| `ExternalMemoryGrantRepo`             | `mintFor/activeForConnection(orgId, connectionId)`      |
| `FeishuAppRegistrationStore`          | `get/claim/authorize(orgId, id, …)`                     |

Each implementation must place the `orgId` in the query predicate, not merely
accept it. A passenger parameter is worse than none: it reads as a fence while
enforcing nothing. Child tables filter through the parent relation
(`where: { botId, bot: { orgId } }`), which fails closed by returning no row.
Denormalizing `orgId` onto child tables with `(childId, orgId)` composite
foreign keys is the stronger form and is left to the broader org-scoping work.

**One carve-out.** The Slack OAuth callback resolves an install by its
unforgeable `state` value and is not mounted under the org subtree, so no
ambient organization exists before the read. It splits: read the row (metadata
only, no secret), take `orgId` from it, then open secrets under that scope. The
authority there is the state token, which is the correct trust root for that
path.

**Reapers** operate across organizations by design (`SlackInstallStore.reapExpired`,
registration expiry). They touch no secret values and keep their current shape.

## 6. Crypto-shredding on organization deletion

Organization deletion is already a single locked transaction that refuses while
any daemon is still registered. Two consequences: there is exactly one place
that could trigger a shred, and the edge is guaranteed to be detached before it
happens — the CP is not shredding a key whose plaintext is still live on a
connected daemon.

Deleting the Vault key cannot be part of that transaction. Rather than persist a
pending-shred intent and reap it, the design uses a **reconciler**, which needs
no new table and is self-healing after any crash:

```
keys   = LIST transit/keys                 # at T0
orgIds = SELECT id FROM org                # at T1 > T0
for key in keys:
    if not key.startsWith(orgPrefix): continue
    suffix = key.slice(orgPrefix.length)
    if not isUuid(suffix): continue
    if suffix not in orgIds: shred(key)
```

**The ordering is load-bearing and must not be swapped.** An org key is created
only when a secret of that organization is first sealed, and every org-scoped
secret hangs off a row with a foreign key to `org` — so a key's existence
implies its organization row existed earlier. Listing keys _before_ reading
organization ids therefore guarantees: a key observed at T0 had a live
organization at T0, so its absence at T1 means a real deletion. A key created
after T0 is simply not in the list and is handled by the next pass. There is no
window in which a live organization's key can be selected.

The two filters — prefix, then UUID-parseable suffix — are what keep the
deployment key and any operator-created key outside the reconciler's reach.
Together with the §4 boot assertion they form the two independent barriers
around an irreversible operation.

**Vault privileges.** Shredding is two calls: `POST transit/keys/<name>/config`
with `deletion_allowed=true`, then `DELETE transit/keys/<name>`. The capability
to destroy tenant data should not be attached to the credential the CP uses for
ordinary encrypt/decrypt. The reconciler therefore takes its own Vault role,
configured separately, and is **disabled unless configured** — self-hosted and
development deployments run without it and simply retain unreferenced keys.

**What the guarantee is.** After a successful shred, database backups taken
before the deletion no longer decrypt that organization's secrets. This is a
statement about our Postgres backups.

**What it is not.** It does not cover Vault's own snapshots — restoring a Vault
snapshot from before the shred restores the key, so snapshot retention is an
operator policy that must be stated alongside the guarantee. It does not reach
plaintext already delivered to a daemon, which lives on customer-owned
infrastructure. And it is only as complete as the migration in §7.

## 7. Migration

Existing deployments already hold ciphertext sealed under the single key. The
legacy arm of `open` (§4) keeps every such value readable with no backfill and
no downtime, so the rollout is a deploy, not a migration window.

The guarantee, however, **is not real until convergence**: a value still sealed
under the deployment key is readable after its organization's key is destroyed.
The order is therefore:

1. Deploy. New writes seal under org keys; legacy values keep reading.
2. Run the rewrap sweep (`secrets/rewrap.ts`) per environment. It resolves each
   row's scope and re-seals under the correct key.
3. Only then is per-organization shredding a claim that holds.

The deployment key is never deleted — legacy `deployment_secret` values stay
under it permanently, and the legacy arm remains until every environment has
converged.

**Gap found while auditing.** `feishu_app_registration` seals `deviceCode` and
`appSecret` through the cipher but is absent from the rewrap sweep. Today that
means plaintext residue in that table never converges and key rotation skips it;
after this change it would mean those values can never be shredded. The table
joins the sweep as part of this work.

## 8. Testing

- **Envelope unit tests**: the three `open` arms, round-trip under two distinct
  org scopes, and a cross-scope open failing rather than returning plaintext.
- **Scope binding**: a table-driven test asserting the scope kind each store
  binds, so a newly added secret table cannot default into the deployment scope.
- **Boot matrix**: startup refuses when `VAULT_TRANSIT_KEY` falls inside the org
  prefix.
- **Cross-tenant contract (integration)**: seal under two organizations, destroy
  one key, assert the other organization's values still open and the destroyed
  organization's values fail closed.
- **Reconciler**: against a stubbed Vault, assert that non-prefixed keys,
  non-UUID suffixes, and live organizations are never selected, and that the
  list-then-read ordering is preserved.

## 9. Open questions

1. **Eager or lazy key creation.** Lazy (first encrypt) is proposed. Eager
   creation at organization creation would make the Vault key list a complete
   inventory, which the reconciler does not need but auditing might.
2. **Per-organization rotation cadence.** Rotation is per key, so a policy that
   was deployment-wide becomes per tenant. Rewrap already supports it; the
   schedule is an operations decision.
3. **Retiring the legacy arm.** Once every environment has converged it can be
   deleted, turning an unrecognized-but-`vault:`-prefixed value into an error
   rather than a deployment-key decrypt.
