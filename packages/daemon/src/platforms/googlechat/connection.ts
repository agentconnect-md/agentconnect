// Google Chat's Layer-1 connection (google-chat-integration.md §5): REST egress with no socket, over the row's transport.
import { createHash, randomUUID } from 'node:crypto'
import {
  googleChatCallRequest,
  type IntegrationGoogleChatConfig,
  type WireGoogleChatCall
} from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { Logger } from '../../log.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import type { PlatformRelay } from '../platform-relay.js'
import { PlatformSendQueue } from '../send-queue.js'
import { renderGoogleChatMarkdown, splitGoogleChatText } from './render.js'
import {
  DirectGoogleChatTransport,
  GoogleChatApiError,
  RelayGoogleChatTransport,
  type GoogleChatFailureKind,
  type GoogleChatTransport
} from './transport.js'
import type { GoogleChatWriteBudget } from './write-budget.js'

export { GOOGLE_CHAT_MARKUP } from '@agentconnect.md/protocol'
export {
  GOOGLE_CHAT_API_ROOT,
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleChatApiError,
  TOKEN_RENEW_MARGIN_MS,
  TOKEN_RETRY_MS,
  type GoogleChatFailureKind
} from './transport.js'

/** Google allows one write per second per Space, shared by every app acting in it (§5). */
export const GOOGLE_CHAT_SPACE_INTERVAL_MS = 1_000
/** A read port's own deadline when its caller sets none — a stall costs a name, never a caller. */
export const GOOGLE_CHAT_READ_DEADLINE_MS = 5_000
const SEND_MAX_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
const SEND_RETRY_CAP_MS = 5_000
const MAX_LISTED_SPACES = 200

/** One connection's worth of consolidated integrations (§7.5 registry group shape). */
export interface ConsolidatedGoogleChatGroup {
  key: string
  agentId: string
  integrationId: string
  config: IntegrationGoogleChatConfig
  integrations: { agentId: string; integrationId: string }[]
}

/** §7.5 opaque identity: the app, its key or the bot row the relay serves, the row's tenant, and the events URL its cards name, so any change opens a new client (§10.8, §11.5). */
export function googleChatConnKey(c: IntegrationGoogleChatConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.projectNumber,
        'egress' in c ? { relay: c.botId } : c.serviceAccountKey,
        c.tenantIds ?? null,
        c.ownTenantIds ?? null,
        c.eventsUrl ?? null
      ])
    )
    .digest('hex')
}

/** The fence a row's config sets: strict keys for a claimed customer (none for the anchor), the recorded customer for one organization's own app. */
type TenantFence = { mode: 'strict'; keys: ReadonlySet<string> } | { mode: 'own'; customer?: string }

function tenantFenceOf(
  config: Pick<IntegrationGoogleChatConfig, 'tenantIds' | 'ownTenantIds'>
): TenantFence | undefined {
  if (config.tenantIds) return { mode: 'strict', keys: new Set(config.tenantIds) }
  if (config.ownTenantIds) {
    const customer = config.ownTenantIds.find((key) => key.startsWith('customers/'))
    return { mode: 'own', ...(customer ? { customer } : {}) }
  }
  return undefined
}

/** A Space's tenant as the fence reads it: a named Space's owning customer, a DM's single human member's domain. */
type SpaceTenant = { kind: 'space'; customer?: string } | { kind: 'dm'; domain?: string }

/** Group an agent set's Google Chat integrations, one connection per (app, key); a rejected config is skipped. */
export function consolidateGoogleChat(agents: Agent[], log?: Logger): Map<string, ConsolidatedGoogleChatGroup> {
  const groups = new Map<string, ConsolidatedGoogleChatGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'googlechat') continue
      const config = platformIntegrationConfig('googlechat', int)
      if (!config) {
        log?.warn(`googlechat: integration ${int.id} skipped — config failed the googlechat schema`)
        continue
      }
      const key = googleChatConnKey(config)
      const group = groups.get(key)
      if (group) group.integrations.push({ agentId: a.id, integrationId: int.id })
      else
        groups.set(key, {
          key,
          agentId: a.id,
          integrationId: int.id,
          config,
          integrations: [{ agentId: a.id, integrationId: int.id }]
        })
    }
  }
  return groups
}

export interface GoogleChatDeps {
  group: ConsolidatedGoogleChatGroup
  log?: Logger
  /** Injected so tests need no network. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Wall clock, injectable for tests; token expiry is absolute time. */
  now?: () => number
  /** Backoff and queue sleep, injectable so a fake clock does not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  /** Min spacing (ms) between writes into one Space. Tests pass 0. */
  sendIntervalMs?: number
  /** Jitter source in [0, 1); injectable for deterministic backoff. */
  random?: () => number
  /** Per-request id for chrome creates; injectable for tests. */
  newRequestId?: () => string
  /** The app's write budget on this daemon, shared by every connection of the app (§10.8); absent ⇒ unbudgeted. */
  budget?: GoogleChatWriteBudget
  /** The daemon's relays, the only way out for a deployment app's row (§10.10); absent ⇒ such a row sends nothing. */
  relay?: PlatformRelay
}

/** A Chat message the daemon created, addressed by its resource name and the id it chose. */
export interface GoogleChatMessageRef {
  name: string
  clientId?: string
  text?: string
  /** The `spaces/…/threads/…` the message landed in, when Google's answer names it. */
  thread?: string
}

/** A Space as `spaces.list` / `spaces.get` describe it. */
interface SpaceResource {
  name?: string
  displayName?: string
  spaceType?: string
  customer?: string
}

interface MembershipResource {
  member?: { name?: string; displayName?: string; type?: string; domainId?: string }
}

interface MessageResource {
  name?: string
  text?: string
  sender?: { name?: string }
  thread?: { name?: string }
}

/** How many send-tool posts remember their thread, for the post's settlement right after the send. */
const POSTED_THREADS_MAX = 256

/** The Chat API's error message, bounded, or the bare status. */
function errorDetail(body: Record<string, unknown> | undefined, status: number): string {
  const message = (body?.error as { message?: unknown } | undefined)?.message
  const text = typeof message === 'string' ? message.trim() : ''
  return text ? `HTTP ${status}: ${text.slice(0, 200)}` : `HTTP ${status}`
}

function classifyStatus(status: number): GoogleChatFailureKind {
  if (status === 401) return 'credential_rejected'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'already_exists'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

export class GoogleChatConnection implements PlatformConnection {
  readonly key: string
  readonly integrationId: string
  readonly agentId: string
  /** The Chat app's Google Cloud project number: its durable identity. */
  readonly projectNumber: string
  /** No permalink base: Chat deep links come from the message's own `spaceUri`, so the console URL is the fallback. */
  readonly workspaceUrl = ''
  /** The relay's public events URL, which every card button names as its function (§11.5). */
  readonly eventsUrl: string | undefined
  private readonly transport: GoogleChatTransport
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly newRequestId: () => string
  private readonly sendIntervalMs: number
  /** One write queue per Space (§5): Google's write quota is per Space, shared by every app in it. */
  private readonly queues = new Map<string, PlatformSendQueue>()
  /** The row's tenant fence (§10.8) and each Space's tenant, read once. */
  private readonly fence: TenantFence | undefined
  private readonly spaceTenants = new Map<string, Promise<SpaceTenant>>()
  /** Send-tool post name → its thread, oldest first, for {@link threadOfPost}. */
  private readonly postedThreads = new Map<string, string>()
  /** Every write takes one token of the app's budget before it runs, under the Space's own spacing. */
  private readonly writeGate: (() => Promise<void>) | undefined
  private appUserName: string | undefined
  private stopped = false

  constructor(private readonly deps: GoogleChatDeps) {
    const { group } = deps
    this.key = group.key
    this.integrationId = group.integrationId
    this.agentId = group.agentId
    this.projectNumber = group.config.projectNumber
    this.eventsUrl = group.config.eventsUrl
    this.now = deps.now ?? (() => Date.now())
    const config = group.config
    // Chosen by the spec alone: a relay row holds no key, so it has no direct path to fall back on.
    this.transport =
      'egress' in config
        ? new RelayGoogleChatTransport(deps.relay, config.botId)
        : new DirectGoogleChatTransport(
            config.serviceAccountKey,
            deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
            this.now,
            deps.log,
            this.integrationId
          )
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = deps.random ?? (() => Math.random())
    this.newRequestId = deps.newRequestId ?? (() => randomUUID())
    this.sendIntervalMs = deps.sendIntervalMs ?? GOOGLE_CHAT_SPACE_INTERVAL_MS
    this.fence = tenantFenceOf(group.config)
    const budget = deps.budget
    this.writeGate = budget ? () => budget.take() : undefined
  }

  /** The app's own `users/…` identity, once a create response names it; Google exposes no app-authenticated read of it (§5). */
  get botUserId(): string | undefined {
    return this.appUserName
  }

  /** The durable tenant anchor Google exposes: the app's project, which survives key rotation. */
  workspaceId(): string {
    return this.projectNumber
  }

  // ── 1. transport lifecycle ──

  /** No socket to open: warm the transport; the app identity comes from traffic, never from a read at connect. */
  async start(): Promise<void> {
    this.stopped = false
    await this.transport.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  // ── 2. egress ──

  /** Create one message under a `client-` id; a repeat, a conflict, or an ambiguous answer reconciles by that id, never a fresh one. */
  async createMessage(input: {
    space: string
    thread?: string
    clientId: string
    text?: string
    cardsV2?: readonly unknown[]
    fallbackText?: string
    /** A `users/…` the message is private to: only they and the app see it (app authentication, which this connection uses). */
    privateViewer?: string
  }): Promise<GoogleChatMessageRef> {
    const call: WireGoogleChatCall = {
      op: 'create-message',
      space: input.space,
      messageId: input.clientId,
      requestId: input.clientId,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.cardsV2 ? { cardsV2: input.cardsV2 as Record<string, unknown>[] } : {}),
      ...(input.fallbackText ? { fallbackText: input.fallbackText } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      ...(input.privateViewer ? { privateViewer: input.privateViewer } : {})
    }
    const byClientId = `${input.space}/messages/${input.clientId}`
    await this.assertOwnTenant(input.space)
    const send = async (): Promise<GoogleChatMessageRef> => {
      const created = await this.request<MessageResource>(call, { retry: 'rate_limit_only' })
      this.noteAppIdentity(created.sender?.name)
      // Only Google's own echo says what the wire shows; a missing one is reported as missing, never as the input.
      return {
        name: created.name ?? byClientId,
        clientId: input.clientId,
        ...(created.text !== undefined ? { text: created.text } : {}),
        ...(created.thread?.name ? { thread: created.thread.name } : {})
      }
    }
    return this.queueFor(input.space).enqueue(async () => {
      try {
        return await send()
      } catch (err) {
        const kind = err instanceof GoogleChatApiError ? err.kind : undefined
        if (kind !== 'already_exists' && kind !== 'ambiguous' && kind !== 'unavailable') throw err
        // The write may have landed: read the id back before anything is sent again (§5).
        const existing = await this.readMessage(byClientId)
        if (existing) return { ...existing, clientId: input.clientId }
        if (kind === 'already_exists') throw err
        // A relay's create that may have reached Google stays as it is, found or not (§10.10).
        if (!this.transport.resendsAmbiguousCreate && !(err as GoogleChatApiError).unsent) throw err
        // Nothing landed: the same request once more — same id, same body.
        return await send()
      }
    }, this.writeGate)
  }

  /** Edit a message this daemon created; `allowMissing` stays off so a deleted message is a `not_found`, never recreated. */
  async patchMessage(name: string, text: string): Promise<void> {
    await this.assertOwnTenant(spaceOf(name))
    await this.queueFor(spaceOf(name)).enqueue(
      () => this.request<MessageResource>({ op: 'patch-text', message: name, text }, { retry: 'idempotent' }),
      this.writeGate
    )
  }

  /** Delete a message this daemon created, as a withdrawn placeholder is; one already gone counts as deleted. */
  async deleteOwnMessage(name: string): Promise<void> {
    await this.assertOwnTenant(spaceOf(name))
    await this.queueFor(spaceOf(name)).enqueue(async () => {
      try {
        await this.request<MessageResource>({ op: 'delete-message', message: name }, { retry: 'idempotent' })
      } catch (err) {
        if (!(err instanceof GoogleChatApiError && err.kind === 'not_found')) throw err
      }
    }, this.writeGate)
  }

  /** Replace the cards of a message this daemon created, as a settled elicitation card is rewritten. */
  async patchCards(name: string, cardsV2: readonly unknown[]): Promise<void> {
    await this.assertOwnTenant(spaceOf(name))
    await this.queueFor(spaceOf(name)).enqueue(
      () =>
        this.request<MessageResource>(
          { op: 'patch-cards', message: name, cardsV2: cardsV2 as Record<string, unknown>[] },
          { retry: 'idempotent' }
        ),
      this.writeGate
    )
  }

  /** Read one message back by resource name or `client-` id; undefined when Google has no such message. */
  async getMessage(name: string): Promise<GoogleChatMessageRef | undefined> {
    return this.queueFor(spaceOf(name)).enqueue(() => this.readMessage(name))
  }

  /** Post chrome (a command reply, a failure notice) with a per-call request id, so a retry cannot double-post. */
  async postChrome(space: string, thread: string | undefined, text: string): Promise<void> {
    const call: WireGoogleChatCall = {
      op: 'create-message',
      space,
      requestId: this.newRequestId(),
      text,
      ...(thread ? { thread } : {})
    }
    await this.assertOwnTenant(space)
    await this.queueFor(space).enqueue(async () => {
      const retry = this.transport.resendsAmbiguousCreate ? 'idempotent' : 'rate_limit_only'
      const created = await this.request<MessageResource>(call, { retry })
      this.noteAppIdentity(created.sender?.name)
    }, this.writeGate)
  }

  /** A post from the send tool, outside any turn: rendered and split as a reply is, each part under its own `client-` id; answers the first part's name. */
  async postMessage(channel: string, text: string, thread?: string): Promise<string | undefined> {
    let first: GoogleChatMessageRef | undefined
    for (const part of splitGoogleChatText(renderGoogleChatMarkdown(text))) {
      // A long post's later parts follow its first into the same thread.
      const into = thread ?? first?.thread
      const created = await this.createMessage({
        space: channel,
        ...(into ? { thread: into } : {}),
        clientId: `client-${this.newRequestId()}`,
        text: part
      })
      first ??= created
    }
    if (first?.thread) {
      this.postedThreads.set(first.name, first.thread)
      if (this.postedThreads.size > POSTED_THREADS_MAX)
        this.postedThreads.delete(this.postedThreads.keys().next().value!)
    }
    return first?.name
  }

  /** The thread a send-tool post landed in, which a reply to it carries; a message name says nothing about it (§5). */
  threadOfPost(postId: string): string | undefined {
    return this.postedThreads.get(postId)
  }

  // ── tenant fence (§10.8) ──

  /** Refuse a write into a Space outside the row's tenant; a row with no fence writes anywhere, as before. */
  private async assertOwnTenant(space: string): Promise<void> {
    const fence = this.fence
    if (!fence) return
    const tenant = await this.spaceTenant(space)
    const permitted =
      fence.mode === 'strict'
        ? tenant.kind === 'space'
          ? tenant.customer !== undefined && fence.keys.has(tenant.customer)
          : tenant.domain !== undefined && fence.keys.has(tenant.domain)
        : // One organization's own app: its Spaces are its customer's, and its DMs can only be its own people's (§10.3).
          tenant.kind === 'dm' || fence.customer === undefined || tenant.customer === fence.customer
    if (!permitted) {
      throw new GoogleChatApiError(`${space} belongs to another Google Workspace customer`, 'tenant_refused')
    }
  }

  /** The Space's tenant, read once per Space; a failed read is not cached. */
  private spaceTenant(space: string): Promise<SpaceTenant> {
    let pending = this.spaceTenants.get(space)
    if (!pending) {
      pending = this.readSpaceTenant(space).catch((err: unknown) => {
        this.spaceTenants.delete(space)
        throw err
      })
      this.spaceTenants.set(space, pending)
    }
    return pending
  }

  /** `spaces.get` names a named Space's customer; a DM's tenant is its one human member's domain, read only under a strict fence. */
  private async readSpaceTenant(space: string): Promise<SpaceTenant> {
    const resource = await this.request<SpaceResource>({ op: 'get-space', space }, { retry: 'idempotent' })
    if (resource.spaceType !== 'DIRECT_MESSAGE') {
      return { kind: 'space', ...(resource.customer ? { customer: resource.customer } : {}) }
    }
    if (this.fence?.mode !== 'strict') return { kind: 'dm' }
    const page = await this.request<{ memberships?: MembershipResource[] }>(
      { op: 'list-dm-humans', space },
      { retry: 'idempotent' }
    )
    const humans = (page.memberships ?? []).filter((m) => m.member?.type === 'HUMAN')
    const domainId = humans.length === 1 ? humans[0]!.member?.domainId : undefined
    return { kind: 'dm', ...(domainId ? { domain: `domains/${domainId}` } : {}) }
  }

  // ── 3. read port ──

  async getChannelInfo(channel: string, opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelInfo> {
    const signal = opts.signal ?? AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS)
    const space = await this.request<SpaceResource>({ op: 'get-space', space: channel }, { retry: 'none', signal })
    const isIm = space.spaceType === 'DIRECT_MESSAGE'
    // A DM space carries no display name, so its row is named after the one person in it (§5).
    const name = isIm ? await this.dmCounterpartName(channel, signal) : space.displayName
    return { id: channel, ...(name ? { name } : {}), isIm, isPrivate: space.spaceType !== 'SPACE' }
  }

  /** The DM's single human member's display name: app authentication may list human memberships, not the app's own. */
  private async dmCounterpartName(space: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const page = await this.request<{ memberships?: MembershipResource[] }>(
        { op: 'list-dm-humans', space },
        { retry: 'none', signal }
      )
      const humans = (page.memberships ?? []).filter((m) => m.member?.type === 'HUMAN')
      return humans.length === 1 ? humans[0]!.member?.displayName || undefined : undefined
    } catch {
      return undefined
    }
  }

  /** The one human in a DM, by user resource name; undefined when Google lists none or several. */
  async directMessagePerson(space: string): Promise<string | undefined> {
    const page = await this.request<{ memberships?: MembershipResource[] }>(
      { op: 'list-dm-humans', space },
      { retry: 'none', signal: AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS) }
    )
    const humans = (page.memberships ?? []).filter((m) => m.member?.type === 'HUMAN')
    return humans.length === 1 ? humans[0]!.member?.name || undefined : undefined
  }

  /** The app's existing DM with one person (`spaces:findDirectMessage`); throws when they have none. */
  async findDirectMessage(user: string): Promise<string> {
    const space = await this.request<SpaceResource>(
      { op: 'find-direct-message', user },
      { retry: 'none', signal: AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS) }
    )
    if (!space.name) throw new GoogleChatApiError('Google Chat found no direct message with that person', 'not_found')
    return space.name
  }

  /** App authentication lists human memberships only; every page shares the read deadline. */
  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    const signal = AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS)
    const members = new Map<string, PlatformMemberRef>()
    const pages = new Set<string>()
    let pageToken: string | undefined
    do {
      const page = await this.request<{ memberships?: MembershipResource[]; nextPageToken?: string }>(
        { op: 'list-members', space: channel, ...(pageToken ? { pageToken } : {}) },
        { retry: 'none', signal }
      )
      for (const { member } of page.memberships ?? []) {
        if (member?.type !== 'HUMAN' || !member.name) continue
        members.set(member.name, {
          id: member.name,
          ...(member.displayName ? { name: member.displayName } : {}),
          isBot: false
        })
      }
      pageToken = page.nextPageToken || undefined
      if (pageToken) {
        if (pages.has(pageToken)) throw new GoogleChatApiError('Google Chat repeated a membership page', 'invalid')
        pages.add(pageToken)
      }
    } while (pageToken)
    return [...members.values()]
  }

  /** The named Spaces the app is a member of, as the observed conversation rows (§5); DMs surface from traffic. */
  async listChannels(opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelRef[]> {
    const fence = this.fence
    // A customer row lists its customer's Spaces alone, and none without a customer key; an own app lists everything until its customer is known (§10.8).
    const customer =
      fence?.mode === 'strict' ? [...fence.keys].find((key) => key.startsWith('customers/')) : fence?.customer
    if (fence?.mode === 'strict' && customer === undefined) return []
    const spaces = await this.listSpaces(opts.signal ?? AbortSignal.timeout(GOOGLE_CHAT_READ_DEADLINE_MS))
    return spaces
      .filter((space) => space.spaceType === 'SPACE' && space.name && (!customer || space.customer === customer))
      .map((space) => ({
        id: space.name!,
        ...(space.displayName ? { name: space.displayName } : {}),
        isPrivate: false
      }))
  }

  /** Google exposes no app-authenticated profile read; the sender's display name rides the message itself. */
  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    return { id: user }
  }

  /** Attachments are unsupported in both directions (§5): never fetched, never claimed. */
  async downloadFile(_ref: string, _maxBytes?: number): Promise<Buffer | null> {
    return null
  }

  // ── REST transport ──

  /** One Chat API call over the row's transport with bounded, jittered retries: `idempotent` retries every retryable refusal, `rate_limit_only` just a 429; a call that never went out may always be repeated. */
  private async request<T>(
    call: WireGoogleChatCall,
    opts: { retry: 'idempotent' | 'rate_limit_only' | 'none'; signal?: AbortSignal }
  ): Promise<T> {
    if (this.stopped) throw new GoogleChatApiError('connection stopped', 'unavailable')
    const { method, path } = googleChatCallRequest(call)
    let refreshed = false
    for (let attempt = 1; ; attempt += 1) {
      let err: GoogleChatApiError
      try {
        const answer = await this.transport.attempt(call, opts.signal)
        if (answer.status >= 200 && answer.status < 300) return (answer.body ?? {}) as T
        // One 401 may be a token that aged out under us: drop the cache and try once with a fresh mint.
        if (answer.status === 401 && !refreshed) {
          refreshed = true
          this.transport.invalidate()
          continue
        }
        err = new GoogleChatApiError(
          `chat api ${method} ${path} failed: ${errorDetail(answer.body, answer.status)}`,
          classifyStatus(answer.status),
          answer.status,
          answer.retryAfterMs
        )
      } catch (thrown) {
        if (thrown instanceof GoogleChatApiError) {
          if (!thrown.unsent) throw thrown
          err = thrown
        } else {
          err = new GoogleChatApiError(
            `chat api ${method} ${path} did not answer: ${(thrown as Error).message}`,
            'ambiguous'
          )
        }
      }
      const retry =
        err.unsent ||
        (opts.retry === 'idempotent'
          ? err.retryable
          : opts.retry === 'rate_limit_only'
            ? err.kind === 'rate_limited'
            : false)
      if (!retry || attempt >= SEND_MAX_ATTEMPTS) throw err
      const backoff = err.retryAfterMs ?? SEND_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + this.random() * 0.25)
      await this.sleep(Math.min(backoff, SEND_RETRY_CAP_MS))
    }
  }

  private async readMessage(name: string): Promise<GoogleChatMessageRef | undefined> {
    try {
      const message = await this.request<MessageResource>({ op: 'get-message', message: name }, { retry: 'idempotent' })
      this.noteAppIdentity(message.sender?.name)
      return {
        name: message.name ?? name,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.thread?.name ? { thread: message.thread.name } : {})
      }
    } catch (err) {
      if (err instanceof GoogleChatApiError && err.kind === 'not_found') return undefined
      throw err
    }
  }

  private async listSpaces(signal: AbortSignal): Promise<SpaceResource[]> {
    const spaces: SpaceResource[] = []
    let pageToken: string | undefined
    do {
      const page = await this.request<{ spaces?: SpaceResource[]; nextPageToken?: string }>(
        { op: 'list-spaces', ...(pageToken ? { pageToken } : {}) },
        { retry: 'none', signal }
      )
      spaces.push(...(page.spaces ?? []))
      pageToken = page.nextPageToken
    } while (pageToken && spaces.length < MAX_LISTED_SPACES)
    return spaces
  }

  /** Google refuses `members/app` under app authentication, so a message the app wrote is the only source (§5). */
  private noteAppIdentity(name: string | undefined): void {
    if (!this.appUserName && name && /^users\/[^/]+$/.test(name)) this.appUserName = name
  }

  private queueFor(space: string): PlatformSendQueue {
    let queue = this.queues.get(space)
    if (!queue) {
      queue = new PlatformSendQueue(this.sendIntervalMs, this.now, this.sleep)
      this.queues.set(space, queue)
    }
    return queue
  }
}

/** The Space a message resource name lives in — the write queue's key. */
export function spaceOf(name: string): string {
  const m = /^(spaces\/[^/]+)/.exec(name)
  return m?.[1] ?? name
}
