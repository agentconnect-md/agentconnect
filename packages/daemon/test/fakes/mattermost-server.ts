// In-memory Mattermost API v4 REST + WebSocket fake server for unit and E2E tests (no network sockets required).
import type { MattermostFileInfo, MattermostPost } from '@agentconnect.md/message'
import type { Logger } from '../../src/log.js'
import type {
  MattermostChannel,
  MattermostReaction,
  MattermostSocket,
  MattermostTeam,
  MattermostUser
} from '../../src/platforms/mattermost/client.js'

type WsListener = (event: { data: unknown }) => void

export interface SentWsFrame {
  seq: number
  action: string
  data?: Record<string, unknown>
}

export interface RecordedRestRequest {
  method: string
  path: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

export interface QueuedRestFailure {
  method?: string
  pathPrefix: string
  status: number
  headers?: Record<string, string>
  body?: unknown
}

export const quietLog: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

/** Generate deterministic 26-char `[a-z0-9]` Mattermost IDs from a prefix/counter. */
export function fakeMmId(seed: string, n: number): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mm'
  const num = n.toString(36).padStart(6, '0')
  return (base + num + '0'.repeat(26)).slice(0, 26)
}

export class FakeMattermostSocket implements MattermostSocket {
  readyState = 0
  readonly sent: SentWsFrame[] = []
  closedByClient = false
  private authenticated = false
  private readonly listeners = new Map<string, WsListener[]>()
  private serverSeq = 0

  constructor(
    readonly url: string,
    readonly headers: Record<string, string> | undefined,
    private readonly server: FakeMattermostServer
  ) {}

  addEventListener(type: string, listener: WsListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as SentWsFrame
    this.sent.push(frame)

    if (frame.action === 'authentication_challenge') {
      if (this.authenticated) return
      const token = frame.data?.token
      if (this.server.rejectWsAuth || token !== this.server.botToken) {
        queueMicrotask(() => {
          this.reply({
            status: 'FAIL',
            seq_reply: frame.seq,
            error: { id: 'api.context.session_expired.app_error', message: 'Invalid or expired session' }
          })
        })
        return
      }
      this.authenticated = true
      queueMicrotask(() => {
        this.reply({ status: 'OK', seq_reply: frame.seq })
        this.reply({ event: 'hello', data: { server_version: '9.11.0' }, seq: this.serverSeq++ })
      })
      return
    }

    if (frame.action === 'ping') {
      if (this.server.silentPing) return
      queueMicrotask(() => {
        this.reply({
          status: 'OK',
          seq_reply: frame.seq,
          data: { text: 'pong', version: '9.11.0', server_time: Date.now() }
        })
      })
      return
    }
  }

  close(): void {
    this.closedByClient = true
    this.serverClose()
  }

  open(): void {
    this.readyState = 1
    this.emit('open', undefined)
    if (this.headers?.Authorization === `Bearer ${this.server.botToken}` && !this.server.rejectWsAuth) {
      this.authenticated = true
      this.reply({ event: 'hello', data: { server_version: '9.11.0' }, seq: this.serverSeq++ })
    }
  }

  serverClose(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', undefined)
  }

  reply(frame: Record<string, unknown>): void {
    if (this.readyState !== 1) return
    this.emit('message', JSON.stringify(frame))
  }

  /** Push a Mattermost WS `posted` event with JSON-encoded `data.post` and `data.mentions` strings. */
  emitPosted(
    post: MattermostPost,
    opts?: {
      channelType?: string
      channelName?: string
      channelDisplayName?: string
      senderName?: string
      teamId?: string
      mentions?: string[]
    }
  ): void {
    const ch = post.channel_id ? this.server.channels.get(post.channel_id) : undefined
    const user = post.user_id ? this.server.users.get(post.user_id) : undefined
    this.reply({
      event: 'posted',
      data: {
        post: JSON.stringify(post),
        ...(opts?.mentions ? { mentions: JSON.stringify(opts.mentions) } : {}),
        ...((opts?.channelType ?? ch?.type) ? { channel_type: opts?.channelType ?? ch?.type } : {}),
        ...((opts?.channelName ?? ch?.name) ? { channel_name: opts?.channelName ?? ch?.name } : {}),
        ...((opts?.channelDisplayName ?? ch?.display_name)
          ? { channel_display_name: opts?.channelDisplayName ?? ch?.display_name }
          : {}),
        ...((opts?.senderName ?? user?.username) ? { sender_name: opts?.senderName ?? user?.username } : {}),
        ...((opts?.teamId ?? ch?.team_id) ? { team_id: opts?.teamId ?? ch?.team_id } : {})
      },
      broadcast: {
        ...(post.channel_id ? { channel_id: post.channel_id } : {}),
        ...((opts?.teamId ?? ch?.team_id) ? { team_id: opts?.teamId ?? ch?.team_id } : {})
      },
      seq: this.serverSeq++
    })
  }

  /** Push a Mattermost WS `post_edited` event with JSON-encoded `data.post`. */
  emitPostEdited(
    post: MattermostPost,
    opts?: { channelType?: string; senderName?: string; mentions?: string[] }
  ): void {
    const ch = post.channel_id ? this.server.channels.get(post.channel_id) : undefined
    const user = post.user_id ? this.server.users.get(post.user_id) : undefined
    this.reply({
      event: 'post_edited',
      data: {
        post: JSON.stringify(post),
        ...(opts?.mentions ? { mentions: JSON.stringify(opts.mentions) } : {}),
        ...((opts?.channelType ?? ch?.type) ? { channel_type: opts?.channelType ?? ch?.type } : {}),
        ...((opts?.senderName ?? user?.username) ? { sender_name: opts?.senderName ?? user?.username } : {})
      },
      broadcast: {
        ...(post.channel_id ? { channel_id: post.channel_id } : {})
      },
      seq: this.serverSeq++
    })
  }

  emitEvent(event: string, data: Record<string, unknown>, broadcast?: Record<string, unknown>): void {
    this.reply({
      event,
      data,
      ...(broadcast ? { broadcast } : {}),
      seq: this.serverSeq++
    })
  }

  frames(action: string): SentWsFrame[] {
    return this.sent.filter((frame) => frame.action === action)
  }

  private emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

export class FakeMattermostServer {
  readonly serverUrl: string
  readonly botToken: string
  readonly botUser: MattermostUser
  readonly sockets: FakeMattermostSocket[] = []
  readonly requests: RecordedRestRequest[] = []
  readonly queuedFailures: QueuedRestFailure[] = []
  readonly teams = new Map<string, MattermostTeam>()
  readonly channels = new Map<string, MattermostChannel>()
  readonly users = new Map<string, MattermostUser>()
  readonly channelMembers = new Map<string, Set<string>>()
  readonly posts = new Map<string, MattermostPost & { id: string }>()
  readonly postOrder: string[] = []
  readonly ephemeralPosts: Array<{
    id: string
    user_id: string
    channel_id: string
    root_id: string
    message: string
  }> = []
  readonly reactions: MattermostReaction[] = []
  readonly files = new Map<string, { info: MattermostFileInfo; bytes: Buffer; channelId: string }>()

  maxPostSize: string | number | undefined = '4000'
  enablePostUsernameOverride: string | boolean | undefined
  enablePostIconOverride: string | boolean | undefined
  rejectIdentityOverride = false
  requireMembershipToPost = false
  autoOpen = true
  refuseOpens = 0
  rejectWsAuth = false
  silentPing = false
  private idCounter = 1
  private clockMs = 1_767_225_600_000

  constructor(opts?: {
    serverUrl?: string
    botToken?: string
    botUser?: Partial<MattermostUser>
    maxPostSize?: number | string
  }) {
    this.serverUrl = (opts?.serverUrl ?? 'https://mm.example.test').replace(/\/+$/, '')
    this.botToken = opts?.botToken ?? 'mm-bot-token-example'
    this.botUser = {
      id: opts?.botUser?.id ?? fakeMmId('botuser', 1),
      username: opts?.botUser?.username ?? 'acbot',
      is_bot: opts?.botUser?.is_bot ?? true,
      roles: opts?.botUser?.roles ?? 'system_user',
      ...opts?.botUser
    }
    if (opts?.maxPostSize !== undefined) this.maxPostSize = opts.maxPostSize
    this.users.set(this.botUser.id, this.botUser)

    const defaultTeam: MattermostTeam = {
      id: fakeMmId('team', 1),
      name: 'engineering',
      display_name: 'Engineering'
    }
    this.teams.set(defaultTeam.id, defaultTeam)
  }

  nextId(prefix = 'id'): string {
    return fakeMmId(prefix, this.idCounter++)
  }

  addUser(user: MattermostUser): MattermostUser {
    this.users.set(user.id, user)
    return user
  }

  addChannel(channel: MattermostChannel, members: string[] = [this.botUser.id]): MattermostChannel {
    this.channels.set(channel.id, channel)
    const set = this.channelMembers.get(channel.id) ?? new Set<string>()
    for (const m of members) set.add(m)
    this.channelMembers.set(channel.id, set)
    return channel
  }

  addPost(
    post: Partial<MattermostPost> & { channel_id: string; user_id: string; message: string }
  ): MattermostPost & { id: string } {
    const id = post.id ?? this.nextId('post')
    const createAt = post.create_at ?? ++this.clockMs
    const created: MattermostPost & { id: string } = {
      id,
      create_at: createAt,
      update_at: post.update_at ?? createAt,
      delete_at: post.delete_at ?? 0,
      root_id: post.root_id ?? '',
      ...post
    }
    this.posts.set(id, created)
    if (!this.postOrder.includes(id)) this.postOrder.push(id)
    return created
  }

  enqueueFailure(failure: QueuedRestFailure): void {
    this.queuedFailures.push(failure)
  }

  createSocket = (url: string, headers?: Record<string, string>): FakeMattermostSocket => {
    const socket = new FakeMattermostSocket(url, headers, this)
    this.sockets.push(socket)
    if (this.refuseOpens > 0) {
      this.refuseOpens--
      queueMicrotask(() => socket.serverClose())
    } else if (this.autoOpen) {
      queueMicrotask(() => socket.open())
    }
    return socket
  }

  get lastSocket(): FakeMattermostSocket {
    const socket = this.sockets.at(-1)
    if (!socket) throw new Error('no websocket opened yet')
    return socket
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const base = new URL(this.serverUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    const path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
    }

    let parsedBody: unknown
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }

    this.requests.push({
      method,
      path: `${path}${url.search}`,
      url: url.href,
      headers,
      ...(parsedBody !== undefined ? { body: parsedBody } : {})
    })

    const queuedIdx = this.queuedFailures.findIndex(
      (f) => (!f.method || f.method.toUpperCase() === method) && `${path}${url.search}`.startsWith(f.pathPrefix)
    )
    if (queuedIdx >= 0) {
      const [failure] = this.queuedFailures.splice(queuedIdx, 1)
      return jsonResponse(
        failure!.status,
        failure!.body ?? { id: 'fake.error', message: 'Injected failure' },
        failure!.headers
      )
    }

    if (headers.authorization !== `Bearer ${this.botToken}`) {
      return jsonResponse(401, { id: 'api.context.session_expired.app_error', message: 'Invalid token' })
    }

    // Config & me
    if (method === 'GET' && path === '/api/v4/users/me') {
      return jsonResponse(200, this.botUser)
    }
    if (method === 'GET' && path === '/api/v4/config/client') {
      return jsonResponse(200, {
        ...(this.maxPostSize !== undefined ? { MaxPostSize: String(this.maxPostSize) } : {}),
        ...(this.enablePostUsernameOverride !== undefined
          ? { EnablePostUsernameOverride: String(this.enablePostUsernameOverride) }
          : {}),
        ...(this.enablePostIconOverride !== undefined
          ? { EnablePostIconOverride: String(this.enablePostIconOverride) }
          : {})
      })
    }
    if (method === 'GET' && path === '/api/v4/users/me/teams') {
      return jsonResponse(200, [...this.teams.values()])
    }
    if (method === 'GET' && path === '/api/v4/users/me/channels') {
      const joined = [...this.channels.values()].filter((ch) => {
        const members = this.channelMembers.get(ch.id)
        return members?.has(this.botUser.id)
      })
      return jsonResponse(200, joined)
    }

    // Channels
    if (method === 'POST' && path === '/api/v4/channels') {
      const b = parsedBody as { team_id?: string; name?: string; display_name?: string; type?: 'O' | 'P' }
      const ch = this.addChannel({
        id: this.nextId('chan'),
        team_id: b.team_id ?? [...this.teams.keys()][0],
        name: b.name ?? 'new-channel',
        display_name: b.display_name ?? b.name ?? 'New Channel',
        type: b.type ?? 'O'
      })
      return jsonResponse(201, ch)
    }
    if (method === 'POST' && path === '/api/v4/channels/direct') {
      const pair = parsedBody as string[]
      if (!Array.isArray(pair) || pair.length !== 2)
        return jsonResponse(400, { message: 'Invalid direct channel pair' })
      const sorted = [...pair].sort()
      const dmName = `${sorted[0]}__${sorted[1]}`
      const existing = [...this.channels.values()].find((ch) => ch.type === 'D' && ch.name === dmName)
      if (existing) return jsonResponse(200, existing)
      const created = this.addChannel({ id: this.nextId('dmch'), type: 'D', name: dmName }, pair)
      return jsonResponse(201, created)
    }
    if (method === 'POST' && path === '/api/v4/channels/group') {
      const users = parsedBody as string[]
      const created = this.addChannel({ id: this.nextId('gmch'), type: 'G', name: `gm-${users.length}` }, users)
      return jsonResponse(201, created)
    }

    const chMembersUserMatch = /^\/api\/v4\/channels\/([^/]+)\/members\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && chMembersUserMatch) {
      const [, chId, userId] = chMembersUserMatch
      const members = this.channelMembers.get(chId!)
      if (!members?.has(userId!)) {
        return jsonResponse(404, {
          id: 'store.sql_channel.get_member.missing.app_error',
          message: 'Channel member not found'
        })
      }
      members.delete(userId!)
      return jsonResponse(200, { status: 'OK' })
    }
    if (method === 'GET' && chMembersUserMatch) {
      const [, chId, userId] = chMembersUserMatch
      const members = this.channelMembers.get(chId!)
      if (!members?.has(userId!)) {
        return jsonResponse(404, {
          id: 'store.sql_channel.get_member.missing.app_error',
          message: 'Channel member not found'
        })
      }
      return jsonResponse(200, { channel_id: chId, user_id: userId, roles: 'channel_user' })
    }

    const chMembersMatch = /^\/api\/v4\/channels\/([^/]+)\/members$/.exec(path)
    if (chMembersMatch) {
      const chId = chMembersMatch[1]!
      if (method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '0')
        const perPage = Number(url.searchParams.get('per_page') ?? '200')
        const all = [...(this.channelMembers.get(chId) ?? [])].map((user_id) => ({
          channel_id: chId,
          user_id,
          roles: 'channel_user'
        }))
        return jsonResponse(200, all.slice(page * perPage, (page + 1) * perPage))
      }
      if (method === 'POST') {
        const b = parsedBody as { user_id: string }
        const set = this.channelMembers.get(chId) ?? new Set<string>()
        set.add(b.user_id)
        this.channelMembers.set(chId, set)
        return jsonResponse(201, { channel_id: chId, user_id: b.user_id })
      }
    }

    const chPostsMatch = /^\/api\/v4\/channels\/([^/]+)\/posts$/.exec(path)
    if (method === 'GET' && chPostsMatch) {
      const chId = chPostsMatch[1]!
      if (!this.channels.has(chId)) return jsonResponse(404, { message: 'Channel not found' })
      const page = Number(url.searchParams.get('page') ?? '0')
      const perPage = Number(url.searchParams.get('per_page') ?? '60')
      const sinceRaw = url.searchParams.get('since')
      const before = url.searchParams.get('before')
      const after = url.searchParams.get('after')
      const since = sinceRaw !== null ? Number(sinceRaw) : undefined
      const orderIndex = new Map<string, number>()
      this.postOrder.forEach((id, idx) => orderIndex.set(id, idx))
      const sorted = [...this.posts.values()]
        .filter((p) => p.channel_id === chId && !p.delete_at)
        .sort((a, b) => {
          const diff = (b.create_at ?? 0) - (a.create_at ?? 0)
          if (diff !== 0) return diff
          return (orderIndex.get(b.id) ?? 0) - (orderIndex.get(a.id) ?? 0)
        })
      let windowPosts = sorted
      let nextPostId: string | undefined
      let start = page * perPage
      if (before) {
        const beforeIdx = sorted.findIndex((p) => p.id === before)
        windowPosts = beforeIdx >= 0 ? sorted.slice(beforeIdx + 1) : []
        start = 0
      } else if (after) {
        const afterIdx = sorted.findIndex((p) => p.id === after)
        if (afterIdx >= 0) {
          const newer = sorted.slice(0, afterIdx)
          const sliceStart = Math.max(0, newer.length - perPage)
          windowPosts = newer.slice(sliceStart)
          start = 0
          if (sliceStart > 0) nextPostId = newer[sliceStart - 1]?.id
        } else {
          windowPosts = []
          start = 0
        }
      } else if (since !== undefined && Number.isFinite(since)) {
        windowPosts = sorted.filter((p) => (p.create_at ?? 0) >= since || (p.update_at ?? 0) >= since)
      }
      const slice = windowPosts.slice(start, start + perPage)
      const posts: Record<string, MattermostPost> = {}
      const order: string[] = []
      for (const p of slice) {
        posts[p.id] = p
        order.push(p.id)
      }
      const hasMore = !after && start + perPage < windowPosts.length
      return jsonResponse(200, {
        order,
        posts,
        ...(hasMore ? { prev_post_id: windowPosts[start + perPage]?.id } : {}),
        ...(nextPostId ? { next_post_id: nextPostId } : {})
      })
    }

    const chMatch = /^\/api\/v4\/channels\/([^/]+)$/.exec(path)
    if (method === 'GET' && chMatch) {
      const ch = this.channels.get(chMatch[1]!)
      if (!ch) return jsonResponse(404, { id: 'app.channel.get.existing.app_error', message: 'Channel not found' })
      return jsonResponse(200, ch)
    }

    // Users
    if (method === 'POST' && path === '/api/v4/users/ids') {
      const ids = parsedBody as string[]
      return jsonResponse(
        200,
        ids.map((id) => this.users.get(id)).filter((u): u is MattermostUser => Boolean(u))
      )
    }
    if (method === 'POST' && path === '/api/v4/users/usernames') {
      const names = new Set((parsedBody as string[]).map((n) => n.toLowerCase()))
      return jsonResponse(
        200,
        [...this.users.values()].filter((u) => names.has(u.username.toLowerCase()))
      )
    }
    const userMatch = /^\/api\/v4\/users\/([^/]+)$/.exec(path)
    if (method === 'GET' && userMatch) {
      const u = this.users.get(userMatch[1]!)
      if (!u) return jsonResponse(404, { id: 'app.user.get.app_error', message: 'User not found' })
      return jsonResponse(200, u)
    }

    const teamSearchMatch = /^\/api\/v4\/teams\/([^/]+)\/posts\/search$/.exec(path)
    if (method === 'POST' && teamSearchMatch) {
      const teamId = teamSearchMatch[1]!
      if (!this.teams.has(teamId)) return jsonResponse(404, { id: 'app.team.get.app_error', message: 'Team not found' })
      const b = (parsedBody ?? {}) as { terms?: string; include_deleted_channels?: boolean }
      const rawTerms = (b.terms ?? '').trim().toLowerCase()
      const tokens = rawTerms.split(/\s+/).filter(Boolean)
      const firstTeamId = [...this.teams.keys()][0]
      const hits = [...this.posts.values()]
        .filter((p) => {
          if (p.delete_at) return false
          const ch = p.channel_id ? this.channels.get(p.channel_id) : undefined
          if (!ch) return false
          if (!b.include_deleted_channels && ch.delete_at) return false
          if (ch.team_id ? ch.team_id !== teamId : teamId !== firstTeamId) return false
          if (tokens.length === 0) return false
          const msg = (p.message ?? '').toLowerCase()
          return tokens.every((t) => msg.includes(t))
        })
        .sort((a, b) => (b.create_at ?? 0) - (a.create_at ?? 0))
      const posts: Record<string, MattermostPost> = {}
      const order: string[] = []
      for (const p of hits) {
        posts[p.id] = p
        order.push(p.id)
      }
      return jsonResponse(200, { order, posts })
    }

    // Posts
    if (method === 'POST' && path === '/api/v4/posts/ephemeral') {
      const b = parsedBody as {
        user_id: string
        post: { channel_id: string; message?: string; root_id?: string }
      }
      if (!this.channels.has(b.post.channel_id)) {
        return jsonResponse(404, { id: 'app.channel.get.existing.app_error', message: 'Channel not found' })
      }
      const created = {
        id: this.nextId('ephem'),
        create_at: ++this.clockMs,
        update_at: this.clockMs,
        delete_at: 0,
        user_id: b.user_id,
        channel_id: b.post.channel_id,
        root_id: b.post.root_id ?? '',
        message: b.post.message ?? ''
      }
      this.ephemeralPosts.push(created)
      return jsonResponse(201, created)
    }
    if (method === 'POST' && path === '/api/v4/posts') {
      const b = parsedBody as {
        channel_id: string
        message?: string
        root_id?: string
        file_ids?: string[]
        props?: Record<string, unknown>
      }
      if (!this.channels.has(b.channel_id)) {
        return jsonResponse(404, { id: 'app.channel.get.existing.app_error', message: 'Channel not found' })
      }
      if (this.requireMembershipToPost && !this.channelMembers.get(b.channel_id)?.has(this.botUser.id)) {
        return jsonResponse(403, {
          id: 'api.context.permissions.app_error',
          message: 'You do not have the appropriate permissions.'
        })
      }
      if (
        this.rejectIdentityOverride &&
        b.props &&
        ('override_username' in b.props || 'override_icon_url' in b.props)
      ) {
        return jsonResponse(400, {
          id: 'api.post.create_post.override_disabled',
          message: 'Post username/icon override is disabled'
        })
      }
      if (b.root_id) {
        const rootTarget = this.posts.get(b.root_id)
        if (!rootTarget || rootTarget.delete_at || rootTarget.root_id) {
          return jsonResponse(400, {
            id: 'api.post.create_post.root_id.app_error',
            message: 'Invalid RootId parameter'
          })
        }
      }
      const files = (b.file_ids ?? [])
        .map((id) => this.files.get(id)?.info)
        .filter((f): f is MattermostFileInfo => Boolean(f))
      const created = this.addPost({
        channel_id: b.channel_id,
        user_id: this.botUser.id,
        message: b.message ?? '',
        root_id: b.root_id ?? '',
        ...(b.file_ids?.length ? { file_ids: b.file_ids, metadata: { files } } : {}),
        props: { ...(this.botUser.is_bot ? { from_bot: 'true' } : {}), ...b.props }
      })
      return jsonResponse(201, created)
    }

    const patchPostMatch = /^\/api\/v4\/posts\/([^/]+)\/patch$/.exec(path)
    if (patchPostMatch) {
      if (method !== 'PUT') {
        return jsonResponse(405, { message: `Method ${method} not allowed; Mattermost patch requires PUT` })
      }
      const post = this.posts.get(patchPostMatch[1]!)
      if (!post || post.delete_at) return jsonResponse(404, { message: 'Post not found' })
      const b = parsedBody as {
        message?: string
        file_ids?: string[]
        props?: Record<string, unknown>
        is_pinned?: boolean
      }
      if (
        this.rejectIdentityOverride &&
        b.props &&
        ('override_username' in b.props || 'override_icon_url' in b.props)
      ) {
        return jsonResponse(400, {
          id: 'api.post.update_post.override_disabled',
          message: 'Post username/icon override is disabled'
        })
      }
      if (b.message !== undefined) post.message = b.message
      if (b.file_ids !== undefined) post.file_ids = b.file_ids
      if (b.props !== undefined) post.props = { ...post.props, ...b.props }
      if (b.is_pinned !== undefined) post.is_pinned = b.is_pinned
      post.update_at = ++this.clockMs
      return jsonResponse(200, post)
    }

    const threadMatch = /^\/api\/v4\/posts\/([^/]+)\/thread$/.exec(path)
    if (method === 'GET' && threadMatch) {
      const rootId = threadMatch[1]!
      const root = this.posts.get(rootId)
      if (!root || root.delete_at) {
        return jsonResponse(404, { id: 'app.post.get.app_error', message: 'Thread not found' })
      }
      const threadPosts = [...this.posts.values()].filter(
        (p) => !p.delete_at && (p.id === rootId || p.root_id === rootId)
      )
      const posts: Record<string, MattermostPost> = {}
      const order: string[] = []
      for (const p of threadPosts.sort((a, b) => (b.create_at ?? 0) - (a.create_at ?? 0))) {
        posts[p.id] = p
        order.push(p.id)
      }
      return jsonResponse(200, { order, posts })
    }

    const postReactionsMatch = /^\/api\/v4\/posts\/([^/]+)\/reactions$/.exec(path)
    if (method === 'GET' && postReactionsMatch) {
      const postId = postReactionsMatch[1]!
      return jsonResponse(
        200,
        this.reactions.filter((r) => r.post_id === postId)
      )
    }

    const postMatch = /^\/api\/v4\/posts\/([^/]+)$/.exec(path)
    if (postMatch) {
      const post = this.posts.get(postMatch[1]!)
      if (method === 'GET') {
        if (!post || post.delete_at) return jsonResponse(404, { message: 'Post not found' })
        return jsonResponse(200, post)
      }
      if (method === 'DELETE') {
        if (!post || post.delete_at) return jsonResponse(404, { message: 'Post not found' })
        post.delete_at = ++this.clockMs
        return jsonResponse(200, { status: 'OK' })
      }
    }

    // Reactions
    if (method === 'POST' && path === '/api/v4/reactions') {
      const b = parsedBody as { user_id: string; post_id: string; emoji_name: string }
      const reaction: MattermostReaction = { ...b, create_at: ++this.clockMs }
      if (
        !this.reactions.some((r) => r.user_id === b.user_id && r.post_id === b.post_id && r.emoji_name === b.emoji_name)
      ) {
        this.reactions.push(reaction)
      }
      return jsonResponse(201, reaction)
    }
    const delReactionMatch = /^\/api\/v4\/users\/([^/]+)\/posts\/([^/]+)\/reactions\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && delReactionMatch) {
      const [, userId, postId, emojiName] = delReactionMatch
      const idx = this.reactions.findIndex(
        (r) => r.user_id === userId && r.post_id === postId && r.emoji_name === emojiName
      )
      if (idx >= 0) this.reactions.splice(idx, 1)
      return jsonResponse(200, { status: 'OK' })
    }

    // Files
    if (method === 'POST' && path === '/api/v4/files') {
      const channelId = url.searchParams.get('channel_id') ?? ''
      if (!this.channels.has(channelId)) return jsonResponse(404, { message: 'Channel not found' })
      const form = init?.body as FormData | undefined
      const uploaded = form ? form.getAll('files') : []
      const fileInfos: MattermostFileInfo[] = []
      for (const item of uploaded) {
        if (typeof item === 'string') continue
        const bytes = Buffer.from(await item.arrayBuffer())
        const id = this.nextId('file')
        const dot = item.name.lastIndexOf('.')
        const ext = dot >= 0 ? item.name.slice(dot + 1) : ''
        const info: MattermostFileInfo = {
          id,
          user_id: this.botUser.id,
          channel_id: channelId,
          name: item.name,
          extension: ext,
          size: bytes.byteLength,
          mime_type: item.type || 'application/octet-stream',
          has_preview_image: (item.type || '').startsWith('image/')
        }
        this.files.set(id, { info, bytes, channelId })
        fileInfos.push(info)
      }
      return jsonResponse(201, { file_infos: fileInfos, client_ids: [] })
    }

    const fileInfoMatch = /^\/api\/v4\/files\/([^/]+)\/info$/.exec(path)
    if (method === 'GET' && fileInfoMatch) {
      const entry = this.files.get(fileInfoMatch[1]!)
      if (!entry) return jsonResponse(404, { message: 'File not found' })
      return jsonResponse(200, entry.info)
    }

    const fileGetMatch = /^\/api\/v4\/files\/([^/]+)$/.exec(path)
    if (method === 'GET' && fileGetMatch) {
      const entry = this.files.get(fileGetMatch[1]!)
      if (!entry) return jsonResponse(404, { message: 'File not found' })
      const safeName = (entry.info.name ?? 'file').replace(/"/g, '_')
      return new Response(new Uint8Array(entry.bytes), {
        status: 200,
        headers: {
          'content-type': entry.info.mime_type || 'application/octet-stream',
          'content-length': String(entry.bytes.byteLength),
          'content-disposition': `attachment; filename="${safeName}"`
        }
      })
    }

    return jsonResponse(404, { message: `Unhandled fake Mattermost route: ${method} ${path}` })
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}
