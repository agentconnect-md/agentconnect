/**
 * `ApiKeyService` — implements the C4 `ApiKeyAdmin` port (daemon-api-key-auth.md §6/§7).
 *
 * Owns the API-key lifecycle off the hot path: onboarding (provision a `provisioned`
 * daemon row + its first key), rotation/regeneration (mint an additional key for an
 * existing daemon), listing, and revocation. Minting persists ONLY the peppered hash
 * and returns the plaintext exactly once. Audit events are best-effort (never block
 * or fail the operation). Verification lives in `DaemonAuthService`, not here.
 */
import { randomUUID } from 'node:crypto'
import type {
  ApiKeyAdmin,
  ApiKeyView,
  UserApiKeyView,
  UserKeyPrincipal,
  MintedKeyView,
  ProvisionedDaemon
} from '../ports.js'
import type { ApiKeyRepo, ApiKeyRecord, UserApiKeyRecord, DaemonRepo, AuditRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { DaemonId, OrgId } from '../domain/ids.js'
import { ApiKeyCodec } from './apiKey.js'

/** Personal keys expire on a fixed clock (daemon keys don't — §4/§8). */
const DEFAULT_USER_KEY_TTL_DAYS = 90
/** Skip the best-effort `lastUsedAt` write unless the key hasn't been touched for this long
 *  — one write per request would tax a hot key for no product value. */
const LAST_USED_THROTTLE_MS = 60_000

function toView(r: ApiKeyRecord): ApiKeyView {
  return {
    id: r.id,
    displayTail: r.displayTail,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt
  }
}

function toUserView(r: UserApiKeyRecord): UserApiKeyView {
  return { ...toView(r), orgId: r.orgId, orgSlug: r.orgSlug, orgName: r.orgName }
}

export class ApiKeyService implements ApiKeyAdmin {
  constructor(
    private readonly codec: ApiKeyCodec,
    private readonly apiKeys: ApiKeyRepo,
    private readonly daemons: DaemonRepo,
    private readonly audit: AuditRepo,
    private readonly clock: Clock
  ) {}

  async provisionDaemon(opts: { orgId: string; createdByUserId?: string }): Promise<ProvisionedDaemon> {
    const orgId = OrgId(opts.orgId)
    const daemonId = DaemonId(randomUUID())
    // Insert the provisioned row FIRST so the ApiKey FK has a parent (§4.1).
    await this.daemons.provision(daemonId, orgId, opts.createdByUserId)
    const minted = await this.mintForDaemon(orgId, daemonId, opts)
    return { daemonId, ...minted }
  }

  async mintForDaemon(
    orgId: OrgId,
    daemonId: DaemonId,
    opts: { createdByUserId?: string } = {}
  ): Promise<MintedKeyView> {
    // Keys inherit the daemon's org — rotation can't move a daemon across tenants.
    // The read is org-fenced (org-scoped-data-layer.md §3), so a daemon outside
    // the caller's organization is refused here and not only at the route.
    const daemon = await this.daemons.get(orgId, daemonId)
    if (!daemon) throw Object.assign(new Error('daemon not found'), { code: 'P2025' })
    const minted = this.codec.mint()
    const rec = await this.apiKeys.create({
      principalType: 'daemon',
      orgId,
      daemonId,
      hash: minted.hash,
      displayTail: minted.displayTail,
      expiresAt: null, // daemon keys are non-expiring; reaped by idle-liveness, not a clock
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {})
    })
    void this.audit
      .append({
        kind: 'api_key_create',
        orgId,
        daemonId,
        ...(opts.createdByUserId ? { actorUserId: opts.createdByUserId } : {}),
        details: { apiKeyId: rec.id, displayTail: rec.displayTail }
      })
      .catch(() => {})
    return { apiKeyId: rec.id, token: minted.token, displayTail: minted.displayTail }
  }

  async mintForRelay(opts: { name?: string; createdByUserId?: string } = {}): Promise<MintedKeyView> {
    // Relay keys are org-less deployment infra (§8): no daemon FK, no org, non-expiring.
    const minted = this.codec.mint()
    const rec = await this.apiKeys.create({
      principalType: 'relay',
      orgId: null,
      hash: minted.hash,
      displayTail: minted.displayTail,
      expiresAt: null,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {})
    })
    void this.audit
      .append({
        kind: 'api_key_create',
        ...(opts.createdByUserId ? { actorUserId: opts.createdByUserId } : {}),
        details: { apiKeyId: rec.id, displayTail: rec.displayTail, principalType: 'relay' }
      })
      .catch(() => {})
    return { apiKeyId: rec.id, token: minted.token, displayTail: minted.displayTail }
  }

  async listForDaemon(daemonId: DaemonId): Promise<ApiKeyView[]> {
    const rows = await this.apiKeys.listForDaemon(daemonId)
    return rows.map(toView)
  }

  async revoke(apiKeyId: string, reason: string): Promise<ApiKeyView> {
    const rec = await this.apiKeys.revoke(apiKeyId, reason, new Date(this.clock.now()))
    void this.audit
      .append({
        kind: 'api_key_revoke',
        ...(rec.orgId ? { orgId: rec.orgId } : {}), // relay keys are org-less
        ...(rec.daemonId ? { daemonId: rec.daemonId } : {}),
        ...(rec.userId ? { actorUserId: rec.userId } : {}),
        details: { apiKeyId: rec.id, reason }
      })
      .catch(() => {})
    return toView(rec)
  }

  async mintForUser(input: {
    userId: string
    orgId: string
    name?: string
    expiresInDays?: number | null
  }): Promise<MintedKeyView> {
    const orgId = OrgId(input.orgId)
    const minted = this.codec.mint()
    // `null` = a non-expiring key (like daemon keys); otherwise a fixed TTL from now.
    const expiresAt =
      input.expiresInDays === null
        ? null
        : new Date(this.clock.now() + (input.expiresInDays ?? DEFAULT_USER_KEY_TTL_DAYS) * 86_400_000)
    const rec = await this.apiKeys.create({
      principalType: 'user',
      orgId,
      userId: input.userId,
      hash: minted.hash,
      displayTail: minted.displayTail,
      ...(input.name ? { name: input.name } : {}),
      expiresAt,
      createdByUserId: input.userId
    })
    void this.audit
      .append({
        kind: 'api_key_create',
        orgId,
        actorUserId: input.userId,
        details: { apiKeyId: rec.id, displayTail: rec.displayTail, principalType: 'user' }
      })
      .catch(() => {})
    return { apiKeyId: rec.id, token: minted.token, displayTail: minted.displayTail }
  }

  async listForUser(userId: string, opts: { includeRevoked?: boolean } = {}): Promise<UserApiKeyView[]> {
    const rows = await this.apiKeys.listForUser(userId, opts)
    return rows.map(toUserView)
  }

  async mintOauthAccess(input: {
    userId: string
    orgId: string
    scopes: string[]
    oauthGrantId: string
    ttlSeconds?: number
  }): Promise<MintedKeyView> {
    const minted = this.codec.mint()
    const ttlSeconds = input.ttlSeconds ?? 3600 // 1h access token (agent-assistant.md §7)
    const rec = await this.apiKeys.create({
      principalType: 'oauth',
      orgId: OrgId(input.orgId),
      userId: input.userId,
      hash: minted.hash,
      displayTail: minted.displayTail,
      scopes: input.scopes,
      oauthGrantId: input.oauthGrantId,
      expiresAt: new Date(this.clock.now() + ttlSeconds * 1000),
      createdByUserId: input.userId
    })
    return { apiKeyId: rec.id, token: minted.token, displayTail: minted.displayTail }
  }

  async revokeOauthGrantTokens(oauthGrantId: string): Promise<number> {
    return this.apiKeys.revokeByOAuthGrant(oauthGrantId, 'oauth grant revoked', new Date(this.clock.now()))
  }

  async authenticateUser(token: string): Promise<UserKeyPrincipal | null> {
    // 1. Parse offline — malformed/bad-CRC → not a key we issued.
    const parsed = this.codec.parse(token)
    if (!parsed) return null
    // 2. Point-lookup by the peppered hash. A store error PROPAGATES (the auth
    //    plugin maps it to 5xx, not 401 — a transient blip must not read as "bad key").
    const row = await this.apiKeys.findByHash(this.codec.hash(parsed.secret))
    // 3. Fail closed: unknown / not-a-user-key / unbound / revoked / expired → null.
    if (!row) return null
    // A user key OR an OAuth access token (agent-assistant.md §7) both resolve to a
    // human identity + bound org; a daemon/relay key must NEVER authenticate a human request.
    if (row.principalType !== 'user' && row.principalType !== 'oauth') return null
    if (!row.userId) return null
    if (!row.orgId) return null // user keys are always org-bound
    if (row.revokedAt) return null
    const nowMs = this.clock.now()
    if (row.expiresAt && row.expiresAt.getTime() <= nowMs) return null
    // Best-effort, throttled liveness touch — never blocks or fails the request.
    if (!row.lastUsedAt || nowMs - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
      void this.apiKeys.touchLastUsed(row.id, new Date(nowMs)).catch(() => {})
    }
    // Carry the granted scopes so the org-scope guard can confine a scoped (OAuth)
    // token; a personal key's scopes are [] (unrestricted). NEVER drop this — an
    // `mcp:read` token must not authorize writes on the REST surface (§6.3).
    return { userId: row.userId, orgId: row.orgId, apiKeyId: row.id, scopes: row.scopes }
  }
}
