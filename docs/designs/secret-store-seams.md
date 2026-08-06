# Secret Store Seams — Tenant-Secret Access and Encryption

> Status: Implemented. Secret-store interfaces share one injected
> `SecretCipher`; `VaultTransitSecretCipher` is available through
> `SECRET_CIPHER`; and the rewrap convergence script covers every supported
> secret table, including the external-memory secret tables.

## 1. Background

Tenant secrets persisted by the CP are distributed across dedicated tables and
hidden behind store-only read/write seams:

| Secret                                             | Table                                 | Seam                                         |
| -------------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Platform bot tokens and signing secrets            | `bot_secret`                          | `BotSecretStore`                             |
| Write-only secret environment variables for agents | `agent_secret`                        | `AgentSecretStore`                           |
| Webhook HMAC key                                   | `hook_secret`                         | `HookSecretStore`                            |
| MCP upstream authentication headers                | `mcp_provider_secret`                 | `McpProviderSecretStore`                     |
| MCP proxy grant key                                | `mcp_grant.key`                       | `McpGrantRepo`                               |
| Slack config-token installation flow               | `slack_install` / `slack_user_config` | `SlackInstallStore` / `SlackUserConfigStore` |

Hash-only values (`api_key`, `oauth_*`, organization invite links) and
reference-only values (`secret_lease`) are outside this design because they
contain no encryptable plaintext.

The dedicated seams keep secret values out of ordinary records and DTOs, and
the shared cipher provides one transformation point for every persisted tenant
secret.

## 2. Decisions

1. **Keep agent secrets in the row-per-key `agent_secret` table behind `AgentSecretStore`**, matching the BotSecret discipline: values never appear on `AgentRecord` (structurally preventing accidental serialization); lists/DTOs obtain only key names through `keys()` (without loading values); and wire projections (`agent/upsert`, the `register/ok` roster, and `agent/activate`) obtain values through `get()`.
   - Row-per-key rather than a single JSONB row: PATCH's per-key merge semantics (string replaces / null deletes / omission leaves unchanged) map naturally to row-level upserts and deletes without read-modify-write races. `keys()` selects only the key column, so **key names remain available without decryption when an encrypting cipher is enabled**. Encryption operates per value, matching the shape of other stores.
2. **Introduce the `SecretCipher` port (`secrets/cipher.ts`) as the sole at-rest transformation point.** Every secret-store implementation receives the same injected instance. The list grows with new stores, including the two external-memory stores, so construction in `container.ts` is authoritative. Write paths call `seal(plaintext, scope)` and read paths call `open(stored, scope)` — the scope names whose key is used, and is supplied by the caller (see [`per-org-secret-encryption.md`](./per-org-secret-encryption.md)). `PlaintextSecretCipher` is the identity implementation used when encryption is disabled.
   - The composition root (`container.ts` / `buildApp.secretCipher`) constructs one instance and passes it to every store. **Changing encryption means replacing that one instance, switching every secret together.**
3. **Make the cipher constructor argument mandatory**, with no default. Every new store construction site must answer "what is the at-rest transform here?", preventing production wiring omissions from silently falling back to plaintext.
4. **Do not change the C5 lease broker** (`SecretsProvider` / `secret_lease` / protocol §6). It is the end-state track in which the CP never handles plaintext and the daemon resolves references directly against Vault. That track complements the present design, where the CP must hold plaintext and deliver it over a TLS WebSocket. Future adoption is additive.
5. **Update the agent row and secret rows in one transaction.** REST create/PATCH requests go through `AgentConfigWriter` (`PgAgentConfigWriter`, which composes `PgAgentRepo` and secret-row writes inside `withTx`) so both halves commit atomically. Otherwise, a failure in the second step could leave a partially updated definition that reconciliation would replicate unchanged. **Sealing happens outside the transaction** because a real cipher performs network I/O and a transaction must never wait for it. The transaction writes only prepared stored representations: ciphertext with an encrypting cipher, or identity-transformed values when encryption is disabled. The store and writer share the `sealSecretPatch` / `applySealedSecretPatch` helpers. `AgentSecretStore.merge` remains an independent row primitive; `get` and `keys` are unchanged.

## 3. `SecretCipher` Contract

```ts
interface SecretCipher {
  seal(plaintext: string, scope: SecretScope): Promise<string> // plaintext → persisted string
  open(stored: string, scope: SecretScope): Promise<string> // persisted string → plaintext
}
```

The `scope` parameter was added by
[`per-org-secret-encryption.md`](./per-org-secret-encryption.md), which is the
authoritative description of the current contract. It is deliberately **not**
encoded in the stored value: the stored string comes out of Postgres, so letting
it select its own decryption key would mean a row of one organization, read by
code serving another, decrypts silently.

Requirements for a real implementation such as Vault Transit are documented on the port:

- the output of `seal` carries an envelope VERSION tag (never a tenant identity);
- `open` **must pass through values that it did not seal** (no envelope tag ⇒ return unchanged), so plaintext rows remain readable — but it must **refuse** a value that is sealed and unreadable by that build (a pre-scoping ciphertext, or a newer envelope version) rather than hand ciphertext back as plaintext;
- neither method may log its arguments.

This shape also supports the variant in which values move to Vault KV and the column stores a reference (`seal` writes KV and returns a reference; `open` resolves the reference), although Transit remains the recommendation because data stays in Postgres and backup consistency is preserved.

## 4. Affected Surface

- `AgentRecord` / `CreateAgentInput` / `UpdateAgentInput` no longer have a `secrets` field.
- **`AgentSpecAssembler` (`orchestrator/agentSpecAssembler.ts`) assembles every CP→daemon AgentSpec in one place.** All four delivery paths—the reconciliation roster, `replicateUpsert`, icon replication, and agent-move activation—pass through it. `assemble()` reads values from `AgentSecretStore` itself, structurally ensuring that a new path cannot omit secrets. `project()` uses the secrets captured in `MoveBundle.secrets` for moves (preserving fingerprint stability). The assembler also owns icon URL bases, so four sites no longer construct them separately from configuration. `AgentSpecAssembler` is the only caller of the value-reading `AgentSecretStore.get`.
- An agent move's `MoveBundle` carries secrets, so secret edits during a move trigger fingerprint-stability replay at the same priority as integrations/crons.
- REST: secrets from POST/PATCH `/agents` are persisted through `AgentSecretStore.merge`; DTO `secretKeys` values come from `keys()` (one batched query for list endpoints). The API shape is unchanged.
- No wire, daemon, or protocol changes: `AgentSpec.secrets` continues to be delivered over the TLS WebSocket.

## 5. Vault Transit Implementation

**Implemented** (`secrets/vault-transit.ts` + `config/env.ts`):

- `VaultTransitSecretCipher`: calls `transit/encrypt|decrypt/<key>`. `open()` passes through values without a `vault:vN:` prefix. Decrypted results are cached in process by ciphertext, in a bounded insertion-order-evicted cache: reconciliation opens values in batches on every register, and the cache amortizes that to one network request per distinct value. `seal` is not cached because Transit returns fresh ciphertext on every call.
- Two authentication modes: static `VAULT_TOKEN`, or **exchange a JWT file for a token** (`VAULT_JWT_ROLE` + `VAULT_JWT_PATH` + `VAULT_AUTH_MOUNT`; single-flight re-login after 80% of the lease, and re-login plus one retry after a 403). Vault's `kubernetes` and generic `jwt`/OIDC auth methods share the same login wire shape (`{role, jwt}`), so **the code is not bound to Kubernetes**. The defaults—the service-account token path and `mount=kubernetes`—merely make Kubernetes deployment zero-configuration; other platforms can change the path and mount.
- Configuration: `SECRET_CIPHER=none|vault-transit` plus `VAULT_ADDR`, `VAULT_TRANSIT_KEY`, `VAULT_TRANSIT_MOUNT`, `VAULT_NAMESPACE`, and exactly one of `VAULT_TOKEN` or `VAULT_JWT_ROLE`, validated fail-fast at boot.
- Error discipline: errors include only the HTTP status and Vault `errors[]`; plaintext and ciphertext are never echoed.

**Rewrap convergence script:** sweep logic lives in `secrets/rewrap.ts`, with
its entry point in `secrets/rewrap-cli.ts`. For each value across all supported
secret tables—including
the external-memory plugin's `external_memory_connection_secret` /
`external_memory_grant`—it performs `open → seal`. It is idempotent and
resumable, logs only table names and counts, and refuses to run when
`SECRET_CIPHER=none`.

Provider provisioning, workload identity, secret injection, activation order,
and execution of convergence jobs are operator-managed. The application
contract requires the cipher to have only the minimum encrypt/decrypt
capability and forbids logging secret values.
