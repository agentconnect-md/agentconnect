import { createHash } from 'node:crypto'
import type { AcpHost } from '../acp/acp-host.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { formatErr } from '../daemon/text.js'
import type { ModelSessionHost, SelectedTurnHost } from '../daemon/turn-types.js'
import type { Logger } from '../log.js'
import {
  modelProviderTarget,
  type ModelCredential,
  type ModelProviderTarget,
  type ModelRuntimeKind,
  type StaticModelCredentials
} from '../runtimes/model-provider-config.js'
import { DEFAULT_MODEL_KEY_TTL_SECONDS, KeyServerClient, type KeyGrant } from './client.js'

/** The daemon-internal session keys that address a credential lifecycle with no chat session
 *  behind it. Constructors rather than literals so the `internal:` namespace has one owner. */
export const internalSessionKey = {
  dream: (dreamId: string) => `internal:dream:${dreamId}`,
  memory: (agentId: string) => `internal:memory:${agentId}`,
  commit: (agentId: string, nonce: string) => `internal:commit:${agentId}:${nonce}`
}

/** What the pool still needs from the daemon: host construction, store reads, org lookup, log. */
export interface ModelSessionHostPoolHost {
  log(): Logger
  agent(agentId: string): LoadedAgent | undefined
  runtime(kind: string): RuntimeDef | undefined
  orgForAgent(agentId: string): string | undefined
  modelOverride(sessionKey: string): Promise<string | undefined>
  acpSessionId(sessionKey: string): Promise<string | null | undefined>
  sessionKeyForAcpId(agentId: string, acpSessionId: string): Promise<string | undefined>
  sessionSdkQuiescent(agentId: string, acpSessionId: string | null | undefined): boolean
  releaseSdkLease(agentId: string, acpSessionId: string): void
  /** Build + start the confined runtime for one entry, retries included (buildAcpHost seam). */
  startRuntime(agent: LoadedAgent, entry: ModelSessionHost): Promise<AcpHost>
  /** The agent's ordinary warm host, if any — the fallback for a session with no bound host. */
  ordinaryHost(agentId: string): AcpHost | undefined
  /** Drop the agent's config-file secrets once it owns no host of any kind any more. */
  cleanupAgentConfigFiles(agentId: string): void
}

export interface ModelSessionHostPoolOptions {
  address?: string
  tokenPath?: string
  client?: KeyServerClient
  now: () => number
}

/** Owns the per-session model-credential state machine: the key-server handle, the issued grants,
 *  and the confined hosts started against them. */
/** True for an http address whose host is not obviously inside the cluster — a Service name (with
 *  or without its namespace/`.svc` suffix), the local node, or the cluster domain. Deliberately a
 *  shape test rather than a resolver: this runs at construction, and a warning that needed DNS
 *  would be a startup dependency. */
export function offClusterPlaintext(address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
  if (host.endsWith('.svc') || host.endsWith('.svc.cluster.local') || host.endsWith('.local')) return false
  // A bare label (`my-service`) or `service.namespace` is in-cluster addressing; a public name has
  // a registrable domain, which needs at least three labels here (`a.b.c`) not to be one of those.
  return host.split('.').length > 2
}

export class ModelSessionHostPool {
  private readonly entries = new Map<string, ModelSessionHost>()
  readonly keyServer?: KeyServerClient
  /** Deployment-wide provider credentials; base URLs always come from here, key server or not. */
  staticModelCredentials?: StaticModelCredentials

  constructor(
    private readonly host: ModelSessionHostPoolHost,
    private readonly opts: ModelSessionHostPoolOptions
  ) {
    // No `--k8s` requirement: a key server is a credential SOURCE, and where a runtime runs is a
    // different question from where its key comes from. The launch path applies a minted credential
    // to whatever environment it is building, cluster sandbox or local child alike.
    // A token path with no server is a configuration that does nothing — say so and carry on, rather
    // than refusing to start a daemon whose every other agent is fine.
    if (opts.tokenPath && !opts.address && !opts.client) {
      this.log.warn(
        'key-server-token-path is set with no key-server address: no credential will be requested and the token file is unused'
      )
    }
    // The mirror image, and the more expensive mistake: with no token source the client sends the
    // request with NO Authorization header at all — silently. A server that reviews its callers
    // answers 401 to every mint, so every new session fails and the only evidence is per-session.
    // Still a warning and not a refusal: a key server may be configured to trust its callers by
    // network position, and that is its operator's call to make rather than this client's.
    if (opts.address && !opts.tokenPath && !opts.client) {
      this.log.warn(
        `key-server ${opts.address} is configured with no key-server-token-path: requests will carry no credential, which a server that reviews its callers refuses`
      )
    }
    this.keyServer =
      opts.client ??
      (opts.address ? new KeyServerClient(opts.address, { tokenPath: opts.tokenPath, now: opts.now }) : undefined)
    // The scheme is the deployment's to choose, so plaintext is not refused — but plaintext to an
    // address that is NOT plainly in-cluster sends this daemon's bearer token across whatever lies
    // between, which is the one case worth saying out loud. Said once, at construction, because it
    // is a configuration fact rather than a per-request one.
    if (opts.address && offClusterPlaintext(opts.address)) {
      this.log.warn(
        `key-server ${opts.address} is plaintext and does not look in-cluster: the bearer token will cross the network in the clear`
      )
    }
  }

  private get log(): Logger {
    return this.host.log()
  }

  /** Whether this daemon issues session-scoped provider credentials at all. */
  get enabled(): boolean {
    return !!this.keyServer
  }

  has(sessionKey: string): boolean {
    return this.entries.has(sessionKey)
  }

  hasStartedHost(sessionKey: string): boolean {
    return this.entries.get(sessionKey)?.host !== undefined
  }

  hasStartedHostForAgent(agentId: string): boolean {
    return [...this.entries.values()].some((entry) => entry.agentId === agentId && entry.host)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  staticCredential(runtime: ModelRuntimeKind): ModelCredential | undefined {
    return this.staticModelCredentials?.[runtime]
  }

  /** The deployment's base for a target, the only source of one — an IssueKey `baseUrl` is not read. */
  staticBaseUrl(target: ModelProviderTarget): { baseUrl?: string } {
    const baseUrl = this.staticModelCredentials?.[target.runtime]?.baseUrl
    return baseUrl ? { baseUrl } : {}
  }

  async issueKey(agent: Pick<LoadedAgent, 'id'>, target: ModelProviderTarget, sessionKey: string): Promise<KeyGrant> {
    const orgId = this.host.orgForAgent(agent.id)
    if (!orgId) throw new Error(`cannot resolve organization for agent ${agent.id}`)
    if (!this.keyServer) throw new Error('key-server is not configured')
    return await this.keyServer.issue({
      orgId,
      agentId: agent.id,
      sessionId: createHash('sha256').update(sessionKey).digest('hex'),
      provider: target.provider,
      ttlSeconds: DEFAULT_MODEL_KEY_TTL_SECONDS
    })
  }

  /** Give a key back, logging rather than throwing — revoke is idempotent (§5). */
  async revokeKey(keyId: string): Promise<void> {
    await this.keyServer
      ?.revoke(keyId)
      .catch((error) => this.log.warn(`key-server revoke failed for ${keyId} (${formatErr(error)})`))
  }

  async revokeKeyQuietly(keyId: string): Promise<void> {
    await this.keyServer?.revoke(keyId).catch(() => {})
  }

  private selectedTurnHost(entry: ModelSessionHost, host: AcpHost): SelectedTurnHost {
    let cleanup: Promise<void> | undefined
    return {
      host,
      stop: (deadlineMs) => (cleanup ??= this.stopRuntime(entry, host, deadlineMs)),
      waitForCleanup: () => cleanup ?? Promise.resolve()
    }
  }

  async ensure(agent: LoadedAgent, sessionKey: string, effectiveModel?: string): Promise<SelectedTurnHost> {
    const keyServer = this.keyServer
    if (!keyServer) throw new Error('key-server is not configured')
    const runtime = this.host.runtime(agent.runtime)
    if (!runtime) throw new Error(`runtime "${agent.runtime}" is unavailable`)
    const target = modelProviderTarget(
      agent,
      runtime,
      effectiveModel ?? (await this.host.modelOverride(sessionKey)) ?? agent.runtimeOverrides?.model
    )
    if (!target) throw new Error(`runtime "${agent.runtime}" does not support MODEL_TOKEN translation`)
    const now = this.opts.now()
    let entry = this.entries.get(sessionKey)
    if (entry?.stopping) {
      await entry.stopping
      entry = this.entries.get(sessionKey) // a concurrent release may have dropped it
    }
    // A released entry only survives in the map when its stop failed, so its process may still
    // be alive on a key already given back — retry the kill before this session gets a host.
    if (entry?.released) {
      await this.release(sessionKey)
      entry = undefined
    }
    const targetChanged = entry !== undefined && JSON.stringify(entry.target) !== JSON.stringify(target)
    const refreshDue = entry?.grant.refreshAtMs !== undefined && now >= entry.grant.refreshAtMs
    const expired = entry?.grant.expiresAtMs !== undefined && now >= entry.grant.expiresAtMs
    // A started host is authoritative for its whole working life: while its session still has
    // live SDK work, a provider change or a credential refresh is recorded and honoured at the
    // next start, never by swapping the process out from under the work in flight.
    if (entry?.host && (targetChanged || refreshDue || expired) && !(await this.sdkQuiescent(entry))) {
      this.log.debug(`session ${sessionKey}: model host pinned to its start-time credential while SDK work is live`)
      return this.selectedTurnHost(entry, entry.host)
    }
    if (targetChanged) {
      await this.release(sessionKey)
      entry = undefined
    }

    if (!entry || refreshDue || expired) {
      let grant: KeyGrant
      try {
        grant = await this.issueKey(agent, target, sessionKey)
      } catch (error) {
        if (entry?.host && !expired) {
          this.log.warn(`key-server refresh deferred for session ${sessionKey} (${formatErr(error)})`)
          return this.selectedTurnHost(entry, entry.host)
        }
        throw error
      }
      if (entry) {
        const staleKeyId = entry.grant.keyId
        try {
          await this.stopRuntime(entry, entry.host)
        } catch (error) {
          // The map still holds the old entry, so a later release still revokes its key. The
          // grant just issued has no owner at all and the protocol lets one never expire —
          // this is the only place that can still give it back.
          void keyServer
            .revoke(grant.keyId)
            .catch((e) => this.log.warn(`key-server revoke failed for ${grant.keyId} (${formatErr(e)})`))
          throw error
        }
        void keyServer
          .revoke(staleKeyId)
          .catch((error) => this.log.warn(`key-server revoke failed for ${staleKeyId} (${formatErr(error)})`))
      }
      entry = { agentId: agent.id, sessionKey, target, grant }
      this.entries.set(sessionKey, entry)
    }

    const owner = entry
    let host = owner.host
    if (!host) {
      // Publish the start before awaiting it: a concurrent release joins this promise instead
      // of seeing an entry with no host, stopping nothing, and leaking the process it misses.
      const starting: Promise<AcpHost> = (owner.starting ??= this.host
        .startRuntime(agent, owner)
        .then((started) => {
          owner.host = started
          return started
        })
        .finally(() => {
          if (owner.starting === starting) owner.starting = undefined
        }))
      host = await starting
      if (owner.released || this.entries.get(sessionKey) !== owner) {
        await this.stopRuntime(owner, host).catch(() => {})
        throw new Error(`model session host for ${sessionKey} was released during startup`)
      }
    }
    return this.selectedTurnHost(owner, host)
  }

  /** The provider binding the session's current host was started with, when this daemon is the
   *  one injecting its credential. Undefined means nothing is bound — the runtime carries its
   *  own auth — so any model the runtime offers is applicable. */
  boundTarget(sessionKey: string, agentId: string): ModelProviderTarget | undefined {
    const credentialHost = this.entries.get(sessionKey)
    if (credentialHost) return credentialHost.target
    if (this.keyServer || !this.staticModelCredentials) return undefined
    const agent = this.host.agent(agentId)
    const runtime = agent ? this.host.runtime(agent.runtime) : undefined
    const target = agent && runtime ? modelProviderTarget(agent, runtime) : undefined
    // A partial map binds only the providers it configures; the rest keep their runtime-owned auth.
    return target && this.staticModelCredentials[target.runtime] ? target : undefined
  }

  /** Whether a model resolves to a different provider than the one the session's host was
   *  started for. OpenCode model ids are provider-prefixed, so such a pick would land on a
   *  provider whose options never received a key or base URL. */
  crossesHostProvider(sessionKey: string, agentId: string, model: string): boolean {
    const bound = this.boundTarget(sessionKey, agentId)
    if (!bound) return false
    const agent = this.host.agent(agentId)
    const runtime = agent ? this.host.runtime(agent.runtime) : undefined
    const target = agent && runtime ? modelProviderTarget(agent, runtime, model) : undefined
    return !target || JSON.stringify(target) !== JSON.stringify(bound)
  }

  private async sdkQuiescent(entry: ModelSessionHost): Promise<boolean> {
    const acpSessionId = await this.host.acpSessionId(entry.sessionKey)
    return this.host.sessionSdkQuiescent(entry.agentId, acpSessionId)
  }

  async stopRuntime(entry: ModelSessionHost, expectedHost?: AcpHost, deadlineMs?: number): Promise<void> {
    if (entry.stopping) return await entry.stopping
    const host = entry.host
    if (!host || (expectedHost && host !== expectedHost)) return
    entry.host = undefined
    const stopping = host
      .stop(deadlineMs)
      .catch((error) => {
        // A stop that rejects may have left the process alive, so the entry has to keep owning
        // it — dropping the reference is what makes the kill unretryable.
        entry.host ??= host
        throw error
      })
      .finally(async () => {
        if (entry.stopping === stopping) entry.stopping = undefined
        const sessionId = await this.host.acpSessionId(entry.sessionKey)
        if (sessionId) this.host.releaseSdkLease(entry.agentId, sessionId)
      })
    entry.stopping = stopping
    await stopping
  }

  async release(sessionKey: string, deadlineMs?: number): Promise<void> {
    const entry = this.entries.get(sessionKey)
    if (!entry) return
    this.entries.delete(sessionKey)
    entry.released = true
    // Join an in-progress start so the host it produces is stopped rather than left untracked.
    if (entry.starting) await entry.starting.catch(() => undefined)
    let stopError: unknown
    try {
      await this.stopRuntime(entry, entry.host, deadlineMs)
    } catch (error) {
      stopError = error
    }
    await this.keyServer
      ?.revoke(entry.grant.keyId)
      .catch((error) => this.log.warn(`key-server revoke failed for ${entry.grant.keyId} (${formatErr(error)})`))
    // A surviving host means the stop rejected and the process may still be running. Put the
    // entry back so shutdown and the next activation retry the kill; `RevokeKey` is idempotent
    // (§5), so handing the same key back a second time is a no-op.
    if (entry.host && !this.entries.has(sessionKey)) {
      this.entries.set(sessionKey, entry)
      this.log.warn(`session ${sessionKey}: model host stop failed — retained for a retry`)
    }
    if (!this.host.ordinaryHost(entry.agentId) && !this.hasEntryForAgent(entry.agentId)) {
      this.host.cleanupAgentConfigFiles(entry.agentId)
    }
    if (stopError) throw stopError
  }

  private hasEntryForAgent(agentId: string): boolean {
    return [...this.entries.values()].some((candidate) => candidate.agentId === agentId)
  }

  async releaseForAgent(agentId: string, deadlineMs?: number): Promise<void> {
    const keys = [...this.entries.values()]
      .filter((entry) => entry.agentId === agentId)
      .map((entry) => entry.sessionKey)
    await Promise.all(keys.map((key) => this.release(key, deadlineMs)))
  }

  async hostForStoredSession(agentId: string, acpSessionId: string): Promise<AcpHost | undefined> {
    const sessionKey = await this.host.sessionKeyForAcpId(agentId, acpSessionId)
    return (sessionKey ? this.entries.get(sessionKey)?.host : undefined) ?? this.host.ordinaryHost(agentId)
  }
}
