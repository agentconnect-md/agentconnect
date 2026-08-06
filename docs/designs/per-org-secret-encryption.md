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

6. **The CP records a shred intent; a separate workload performs it** (§6).
   Deleting a Vault key is a remote effect that cannot join the Postgres
   transaction that deletes the organization, so that transaction writes a
   tombstone and an operator-run CLI under its own identity destroys the key. No
   code path inside the CP can delete a key, and the shredder never enumerates
   them.

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

| Scope                 | Key name                               |
| --------------------- | -------------------------------------- |
| `{kind:'deployment'}` | `VAULT_TRANSIT_KEY`                    |
| `{kind:'org', orgId}` | `VAULT_TRANSIT_ORG_KEY_PREFIX + orgId` |

`VAULT_TRANSIT_ORG_KEY_PREFIX` **defaults to `${VAULT_TRANSIT_KEY}-org-`**, so
org keys inherit whatever namespace the deployment key already occupies. That
matters whenever several deployments share one transit mount and rely on key
naming alone to stay separated: a fixed prefix would collide their org keys,
while a derived one cannot.

**The identifier is the organization id, never its name or slug.** Names and
slugs are mutable, so a rename would orphan the key — subsequent writes would go
to a new key while existing ciphertext silently became unopenable, surfacing
only at the next read. Key names are also visible to anyone able to list the
mount, and an opaque id leaks no tenant identity. Shredding (§6) likewise has
only the id to work from, because the row is already gone.

Org keys are created lazily on first `encrypt`, which requires the Vault policy
to permit creation on that path. A deployment that would rather pre-create keys
can do so and grant update only.

**Boot assertion.** `VAULT_TRANSIT_ORG_KEY_PREFIX` must be non-empty, and
`VAULT_TRANSIT_KEY` must not begin with it. A deployment key sitting inside the
org namespace would become a shreddable name (§6) — an unrecoverable loss of the
deployment's entire trust root. `loadConfig` refuses to start; the derived
default satisfies the check automatically.

The existing discipline is unchanged: arguments and response bodies are never
logged, `open` results stay cached by ciphertext (the cache key already includes
the envelope, so it remains correct across scopes), and `seal` is never cached.

## 5. Port changes

[`org-scoped-data-layer.md`](./org-scoped-data-layer.md) already establishes the
shape — `get(orgId, id)` for tenant-facing reads, `*Unscoped` for internal trust
domains — and its §3.6 deliberately leaves secret child tables fenced _through
their parent_: a caller reaches `hook_secret` only after `HookRepo.get(orgId, …)`
has already fenced. **That is still true; the org parameter added here is not a
second fence.** It is here because the org now selects the at-rest KEY, which
only the caller can assert: resolving it inside the repository, by joining to the
parent and reading its `orgId`, would be the data choosing its own key — the
failure mode §2.1 exists to prevent. The fence is a by-product.

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

**Callers with no serving tenant** use the existing `*Unscoped` convention
(`org-scoped-data-layer.md` §4) rather than a new exemption of their own, so the
exemption stays greppable instead of hiding behind a row-derived `orgId` that
merely looks like a fence:

| Path                                    | Why it has no ambient org                                                                 | Shape                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Slack OAuth callback                    | unauthenticated, keyed by the unforgeable `state` we minted — that token is the authority | `SlackInstallStore.getUnscoped`, with the inline ESLint exemption      |
| Feishu registration polling             | a background worker fenced by its claim-token lease, a stronger axis than an org          | system-tier methods keep their shape; scope comes from the claimed row |
| Orchestration / reconciliation / replay | processes rows already selected by daemon or relay identity                               | org taken from the record in hand, per §4 of that document             |

The fence catches "a request serving org B fetched org A's row". A worker serving
no tenant has no org B, so there is nothing for it to compare against — the
exemption is honest rather than a weakening.

**Reapers** operate across organizations by design (`SlackInstallStore.reapExpired`,
registration expiry). They touch no secret values and keep their current shape.

The honest boundary: this fence is only as strong as where the `orgId` comes
from. In routes it is `req.orgCtx`; in orchestration it is the fetched record.
The second is equivalent to the first exactly when that fetch was itself
org-scoped — which is what `org-scoped-data-layer.md` M1/M2 already delivered
for the parent repositories.

## 6. Crypto-shredding on organization deletion

Organization deletion is already a single locked transaction that refuses while
any daemon is still registered. Two consequences: there is exactly one place
that could trigger a shred, and the edge is guaranteed to be detached before it
happens — the CP is not shredding a key whose plaintext is still live on a
connected daemon.

**The CP records the intent; it never deletes a key.** Deleting a Vault key is a
remote effect that cannot join the deletion transaction, so that transaction
writes a tombstone instead: one `pending_key_shred` row keyed by the deleted
organization's id, with the time it was recorded. The row has no foreign key —
its whole purpose is to outlive the organization.
A separate operator-run entry point (`secrets/shred-cli.ts`, mirroring the
existing rewrap CLI) drains the table: for each row it destroys
`<orgKeyPrefix><orgId>` and clears the row. Both halves are idempotent, and a
crash between them leaves the tombstone for the next run.

Two properties drive that shape, and both follow from how transit deployments
are commonly arranged.

**Never enumerate keys.** The obvious alternative reconciles `LIST transit/keys`
against `SELECT id FROM org` and shreds the difference, needing no new table.
It is unsafe as soon as one transit mount is shared by more than one deployment
— a common arrangement, since per-deployment key names are themselves the
isolation mechanism. Vault cannot restrict a list to a prefix (the capability
sits on the parent path), so each deployment's reconciler would observe every
other deployment's org keys, and any id absent from _its own_ database looks
exactly like a deletion. Correctness would then rest entirely on a string-prefix
check in application code, guarding an irreversible operation on another
deployment's data. Deriving key names from ids this deployment recorded itself
removes the failure mode by construction: the shredder cannot produce a key name
it did not build from its own tombstone.

**A separate Vault role is not enough; it needs a separate identity.** Roles in
a workload-identity auth method bind to the workload's service account, so a
second role bound to the same account is reachable by the same process merely by
naming it at login. The destructive capability is genuinely separated only when
the shredder runs as its own workload under its own identity — which is also why
it is a CLI rather than a loop inside the CP. The CP's own credential keeps the
encrypt/decrypt capability it has today, widened only to the org key prefix, and
**no code path inside the CP can delete a key.**

**Vault privileges for the shredder.** Two calls per key: `POST
transit/keys/<name>/config` with `deletion_allowed=true`, then `DELETE
transit/keys/<name>`, scoped to the org key prefix. No list capability is
required. A deployment that never configures a shredder simply accumulates
unreferenced keys, which is the right default for self-hosted and development
installs.

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

- **Envelope unit tests** (`secrets/vault-transit.test.ts`): key selection per
  scope, the legacy arm decrypting under the deployment key whatever the scope
  says, the plaintext pass-through arm, and — the one that matters — a
  cross-scope open FAILING rather than returning another org's plaintext. The
  fake Transit binds each ciphertext to the key that produced it, so that
  refusal is the real mechanism, not a stub.
- **Cache key**: a second scope must not be served a cached plaintext; the test
  asserts the extra Vault call, since a ciphertext-only cache key would leak.
- **Key naming** (`secrets/cipher.test.ts`): the prefix derives from the
  deployment key, two deployments on one mount cannot collide, and the derived
  default can never conflict with its own deployment key.
- **Boot matrix**: startup refuses when `VAULT_TRANSIT_KEY` falls inside the org
  prefix, or when the prefix is empty — checked in every cipher mode, because
  the naming mistake is what makes the deployment key shreddable.
- **Cross-tenant contract (integration)**: the two-organization fixture in
  `test/integration/tenant-isolation.route.test.ts` gains the secret-bearing
  resources — a foreign id reads as absent rather than returning a value sealed
  under another key. Extending that suite is the acceptance gate, not a new one.
- **Tombstone lifecycle**: organization deletion writes exactly one tombstone in
  the same transaction (none written when the deletion is refused), and the
  shredder is idempotent — a re-run over an already-destroyed key clears its row
  without error, and a failure mid-key leaves the row for the next run.
- **Shredder key naming**: the destroyed name is always
  `<orgKeyPrefix><tombstone.orgId>`, asserted against a stubbed Vault, and no
  list call is ever issued.

## 9. Open questions

1. **Eager or lazy key creation.** Lazy (first encrypt) is proposed. Eager
   creation at organization creation would make the Vault key list a complete
   inventory, which nothing in this design needs but auditing might.
2. **Per-organization rotation cadence.** Rotation is per key, so a policy that
   was deployment-wide becomes per tenant. Rewrap already supports it; the
   schedule is an operations decision.
3. **Retiring the legacy arm.** Once every environment has converged it can be
   deleted, turning an unrecognized-but-`vault:`-prefixed value into an error
   rather than a deployment-key decrypt.
