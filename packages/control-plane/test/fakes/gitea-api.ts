/**
 * Stateful fake Gitea edge for integration tests — the `FetchLike` twin of `gitlab-api.ts`.
 * Serves the token's user, the version, the scope-probed listings, repositories by id and path,
 * the collaborator permission lookup, and the managed-webhook surface with the two provider
 * quirks the probe recorded (gitea-integration.md §16): unknown subscription names are silently
 * dropped, umbrella names expand. Route matching is base-relative, so one fake serves gitea.com
 * and a path-prefixed self-hosted instance alike.
 *
 * Every identifier here is synthetic.
 */
import { GiteaApiClient, type FetchLike } from '../../src/gitea/api.js'

export interface FakeGiteaRepo {
  id: number
  full_name: string
  default_branch?: string
  private?: boolean
  /** Whether the bot holds `admin` (§4.4); flipped mid-test to drive admin_degraded. */
  admin: boolean
}

export interface FakeGiteaOptions {
  /** The instance this fake stands in for; default gitea.com. */
  baseUrl?: string
  version?: string
  /** The bot the accepted token authenticates as. */
  bot?: { id: number; login: string; full_name?: string }
  /** The one token the fake accepts; anything else answers 401. */
  token?: string
  /** The token's scope level per category (§16: read for GET, write for the mutating methods); absent ⇒ none. */
  scopes?: Partial<Record<GiteaScopeCategory, 'read' | 'write'>>
  repositories?: FakeGiteaRepo[]
  /** Organizations the bot belongs to; their repositories are the ones whose owner is the org. */
  organizations?: string[]
  /** Known users by login, for the §8 username-to-id re-resolution. */
  users?: Record<string, number>
  /** The collaborator permission each login holds on every repository (§8). */
  permissions?: Record<string, 'none' | 'read' | 'write' | 'admin' | 'owner'>
  /** Subscription names the instance silently drops on hook create/update (§16). */
  dropEvents?: string[]
  maxResponseItems?: number
  /** Runs when a test delivery is fired — the place a test lets the relay "observe" it (§6 step 4). */
  onTestDelivery?: (hookId: number) => Promise<void> | void
}

export type GiteaScopeCategory = 'user' | 'repository' | 'organization' | 'issue'

/** A token narrowed to exactly the four scopes of §4.1. */
export const FULL_SCOPES: Record<GiteaScopeCategory, 'read' | 'write'> = {
  user: 'read',
  repository: 'write',
  organization: 'read',
  issue: 'write'
}

export interface FakeGiteaHook {
  repoId: number
  url: string
  secret: string
  content_type: string
  events: string[]
  active: boolean
}

/** Subscription names Gitea knows; anything else is dropped with a 201 (§16). */
const KNOWN_EVENTS = new Set([
  'create',
  'delete',
  'fork',
  'push',
  'issues',
  'issue_assign',
  'issue_label',
  'issue_milestone',
  'issue_comment',
  'pull_request',
  'pull_request_assign',
  'pull_request_label',
  'pull_request_milestone',
  'pull_request_comment',
  'pull_request_review',
  'pull_request_review_request',
  'pull_request_sync',
  'release',
  'repository',
  'wiki'
])

/** The umbrella expansion the probe recorded for `issues`. */
const UMBRELLAS: Record<string, string[]> = {
  issues: ['issues', 'issue_assign', 'issue_label', 'issue_milestone', 'issue_comment']
}

function pageOf(url: string): { page: number; limit: number } {
  const params = new URL(url).searchParams
  return { page: Number(params.get('page') ?? '1'), limit: Number(params.get('limit') ?? '30') }
}

/** Gitea-shaped paging: one `limit` slice, `X-Total-Count`, and — where the upstream listing sets one — a `Link` with rel="next". */
function page<T>(url: string, rows: readonly T[], limitCap: number, withLink = true): Response {
  const { page: index, limit: asked } = pageOf(url)
  const limit = Math.min(asked, limitCap)
  const slice = rows.slice((index - 1) * limit, index * limit)
  const headers: Record<string, string> = { 'x-total-count': String(rows.length) }
  if (withLink && index * limit < rows.length) {
    const next = new URL(url)
    next.searchParams.set('page', String(index + 1))
    headers.link = `<${next.toString()}>; rel="next"`
  }
  return Response.json(slice, { headers })
}

export class FakeGitea {
  readonly opts: Required<Omit<FakeGiteaOptions, 'onTestDelivery' | 'dropEvents'>> & FakeGiteaOptions
  readonly api: GiteaApiClient
  /** What `GET /version` answers NOW — assign mid-test to downgrade. */
  version: string
  /** The token the fake accepts NOW — reassign to revoke the connection's token mid-test. */
  token: string
  repositories: FakeGiteaRepo[]
  permissions: Record<string, 'none' | 'read' | 'write' | 'admin' | 'owner'>
  hooks = new Map<number, FakeGiteaHook>()
  /** Test deliveries fired, by hook id. */
  tests: number[] = []
  /** Every call the CP made, with the token it presented — WHICH token a check used is part of the contract. */
  requests: { method: string; url: string; token: string | null; body?: unknown }[] = []
  private nextId = 7000

  constructor(options: FakeGiteaOptions = {}) {
    this.opts = {
      baseUrl: options.baseUrl ?? 'https://gitea.com',
      version: options.version ?? '1.27.3',
      bot: options.bot ?? { id: 9042, login: 'example-bot', full_name: 'Example Bot' },
      token: options.token ?? 'gitea-token-1',
      scopes: options.scopes ?? FULL_SCOPES,
      repositories: options.repositories ?? [
        { id: 556677, full_name: 'example-org/example-repo', default_branch: 'main', private: false, admin: true }
      ],
      organizations: options.organizations ?? ['example-org'],
      users: options.users ?? { alice: 515151, mallory: 606060, 'example-bot': 9042 },
      permissions: options.permissions ?? { alice: 'write', mallory: 'none' },
      maxResponseItems: options.maxResponseItems ?? 50,
      ...options
    }
    this.version = this.opts.version
    this.token = this.opts.token
    this.repositories = this.opts.repositories.map((repo) => ({ ...repo }))
    this.permissions = { ...this.opts.permissions }
    this.api = new GiteaApiClient(this.opts.baseUrl, this.fetch())
  }

  /** The repository a test addresses, by id. */
  repo(id: number): FakeGiteaRepo {
    const found = this.repositories.find((repo) => repo.id === id)
    if (!found) throw new Error(`fake gitea: no repository ${id}`)
    return found
  }

  private repoJson(repo: FakeGiteaRepo): Record<string, unknown> {
    const [owner, name] = repo.full_name.split('/')
    return {
      id: repo.id,
      name,
      full_name: repo.full_name,
      owner: { id: this.opts.organizations.includes(owner!) ? 100 : this.opts.bot.id, login: owner },
      private: repo.private === true,
      clone_url: `${this.opts.baseUrl}/${repo.full_name}.git`,
      html_url: `${this.opts.baseUrl}/${repo.full_name}`,
      default_branch: repo.default_branch ?? 'main',
      permissions: { admin: repo.admin, push: true, pull: true }
    }
  }

  private hookJson(id: number, hook: FakeGiteaHook): Record<string, unknown> {
    return {
      id,
      type: 'gitea',
      active: hook.active,
      events: hook.events,
      config: { url: hook.url, content_type: hook.content_type },
      created_at: '2026-09-12T00:00:00Z',
      updated_at: '2026-09-12T00:00:00Z'
    }
  }

  /** What the instance actually stores: unknown names dropped, umbrellas expanded (§16). */
  private storedEvents(requested: unknown): string[] {
    const asked = Array.isArray(requested) ? requested.filter((e): e is string => typeof e === 'string') : []
    const stored = new Set<string>()
    for (const name of asked) {
      if (!KNOWN_EVENTS.has(name) || this.opts.dropEvents?.includes(name)) continue
      for (const expanded of UMBRELLAS[name] ?? [name]) stored.add(expanded)
    }
    return [...stored]
  }

  /** §16: the level comes from the method, the category from the route group, and the check runs before anything resolves. */
  private scopeRefusal(category: GiteaScopeCategory, method: string): Response | null {
    const level = method === 'GET' ? 'read' : 'write'
    const held = this.opts.scopes[category]
    if (held === 'write' || (held === 'read' && level === 'read')) return null
    return Response.json(
      { message: `token does not have at least one of required scope(s), required=[${level}:${category}]` },
      { status: 403 }
    )
  }

  /** The route group's category (§16): the second `/repos` group is the issue one. */
  private categoryOf(route: string): GiteaScopeCategory | null {
    if (route === '/user' || route.startsWith('/users/')) return 'user'
    if (route === '/user/repos' || route.startsWith('/repositories/')) return 'repository'
    if (route === '/user/orgs' || route.startsWith('/orgs/')) return 'organization'
    if (/^\/repos\/[^/]+\/[^/]+\/issues(?:\/|$)/.test(route)) return 'issue'
    if (route.startsWith('/repos/')) return 'repository'
    return null
  }

  fetch(): FetchLike {
    return async (url, init) => {
      const method = init?.method ?? 'GET'
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization
      const token = authorization?.replace(/^token /, '') ?? null
      const body = (): Record<string, unknown> => {
        try {
          return JSON.parse(rawBody) as Record<string, unknown>
        } catch {
          return {}
        }
      }
      this.requests.push({ method, url, token, ...(rawBody ? { body: body() } : {}) })
      const path = url.startsWith(`${this.opts.baseUrl}/api/v1`)
        ? url.slice(`${this.opts.baseUrl}/api/v1`.length)
        : null
      if (path === null) throw new Error(`fake gitea: request outside the instance base: ${url}`)
      const route = path.split('?')[0]!

      // The unauthenticated reads (§3, git-workspace-model.md §6).
      if (route === '/version') return Response.json({ version: this.version })
      if (route === '/settings/api') {
        return Response.json({ max_response_items: this.opts.maxResponseItems, default_paging_num: 30 })
      }
      const publicRepo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(route)
      if (publicRepo && token === null) {
        const repo = this.repositories.find((candidate) => candidate.full_name === `${publicRepo[1]}/${publicRepo[2]}`)
        if (!repo || repo.private) return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        return Response.json(this.repoJson(repo))
      }
      if (token !== this.token) return Response.json({ message: 'token is required' }, { status: 401 })
      // The scope gate precedes every handler, existence checks included (§16).
      const category = this.categoryOf(route)
      if (category !== null) {
        const refused = this.scopeRefusal(category, method)
        if (refused) return refused
      }
      if (route === '/user/orgs') {
        // `GET /user/orgs` needs the user AND organization scopes together (§16).
        const refused = this.scopeRefusal('user', method)
        if (refused) return refused
      }

      if (route === '/user') return Response.json({ ...this.opts.bot, username: this.opts.bot.login })
      const userByLogin = /^\/users\/([^/]+)$/.exec(route)
      if (userByLogin) {
        const login = decodeURIComponent(userByLogin[1]!)
        const id = this.opts.users[login]
        if (id === undefined)
          return Response.json({ message: `user does not exist [uid: 0, name: ${login}]` }, { status: 404 })
        return Response.json({ id, login, username: login })
      }
      if (route === '/user/repos') {
        const own = this.repositories.filter((repo) => !this.opts.organizations.includes(repo.full_name.split('/')[0]!))
        return page(
          url,
          own.map((repo) => this.repoJson(repo)),
          this.opts.maxResponseItems
        )
      }
      if (route === '/user/orgs') {
        return page(
          url,
          this.opts.organizations.map((name, index) => ({ id: 100 + index, name, username: name })),
          this.opts.maxResponseItems
        )
      }
      const orgRepos = /^\/orgs\/([^/]+)\/repos$/.exec(route)
      if (orgRepos) {
        const org = decodeURIComponent(orgRepos[1]!)
        const rows = this.repositories.filter((repo) => repo.full_name.split('/')[0] === org)
        return page(
          url,
          rows.map((repo) => this.repoJson(repo)),
          this.opts.maxResponseItems
        )
      }
      const byId = /^\/repositories\/(\d+)$/.exec(route)
      if (byId) {
        const repo = this.repositories.find((candidate) => candidate.id === Number(byId[1]))
        if (!repo) return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        return Response.json(this.repoJson(repo))
      }
      const permission = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(route)
      if (permission) {
        const repo = this.repositories.find((candidate) => candidate.full_name === `${permission[1]}/${permission[2]}`)
        if (!repo) return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        const login = decodeURIComponent(permission[3]!)
        // §16: the bot may read another user's permission only as a repository admin.
        if (!repo.admin && login !== this.opts.bot.login) {
          return Response.json(
            {
              message:
                'Only admins can query all permissions, repo admins can query all repo permissions, collaborators can query only their own'
            },
            { status: 403 }
          )
        }
        const id = this.opts.users[login]
        if (id === undefined)
          return Response.json({ message: `user does not exist [uid: 0, name: ${login}]` }, { status: 404 })
        const answer = this.permissions[login] ?? 'none'
        return Response.json({ permission: answer, role_name: answer, user: { id, login, username: login } })
      }

      // The issue-scoped writes the connect step probes against a nonexistent repository (§4.1).
      const issueRoute = /^\/repos\/([^/]+)\/([^/]+)\/issues\//.exec(route)
      if (issueRoute) {
        const repo = this.repositories.find((candidate) => candidate.full_name === `${issueRoute[1]}/${issueRoute[2]}`)
        if (!repo) return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        return Response.json({ message: 'issue does not exist' }, { status: 404 })
      }

      const hooks = /^\/repos\/([^/]+)\/([^/]+)\/hooks(?:\/(\d+)(\/tests)?)?$/.exec(route)
      if (hooks) {
        const repo = this.repositories.find((candidate) => candidate.full_name === `${hooks[1]}/${hooks[2]}`)
        if (!repo) return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        // Webhook administration is the §4.4 admin grant; a demoted bot is refused, never a 201.
        if (!repo.admin && method !== 'GET')
          return Response.json({ message: 'user does not have access' }, { status: 403 })
        const hookId = hooks[3] !== undefined ? Number(hooks[3]) : undefined
        if (hookId === undefined && method === 'GET') {
          // Upstream `ListHooks` sets X-Total-Count but no Link header.
          const rows = [...this.hooks.entries()].filter(([, hook]) => hook.repoId === repo.id)
          return page(
            url,
            rows.map(([id, hook]) => this.hookJson(id, hook)),
            this.opts.maxResponseItems,
            false
          )
        }
        if (hookId === undefined && method === 'POST') {
          const payload = body()
          const config = (payload.config ?? {}) as Record<string, unknown>
          const id = ++this.nextId
          const hook: FakeGiteaHook = {
            repoId: repo.id,
            url: String(config.url),
            secret: String(config.secret),
            content_type: String(config.content_type),
            events: this.storedEvents(payload.events),
            // The API default is inactive (§7): only an explicit `active: true` arms the hook.
            active: payload.active === true
          }
          this.hooks.set(id, hook)
          return Response.json(this.hookJson(id, hook), { status: 201 })
        }
        const hook = hookId !== undefined ? this.hooks.get(hookId) : undefined
        if (hookId === undefined || !hook || hook.repoId !== repo.id) {
          return Response.json({ message: "The target couldn't be found." }, { status: 404 })
        }
        if (hooks[4] === '/tests' && method === 'POST') {
          this.tests.push(hookId)
          await this.opts.onTestDelivery?.(hookId)
          return new Response(null, { status: 204 })
        }
        if (method === 'GET') return Response.json(this.hookJson(hookId, hook))
        if (method === 'PATCH') {
          // Upstream `editHook`: url and content_type honored, the secret NEVER assigned, the subscription rebuilt from `events` (omitted ⇒ none).
          const payload = body()
          const config = (payload.config ?? {}) as Record<string, unknown>
          if (typeof config.url === 'string') hook.url = config.url
          if (typeof config.content_type === 'string') hook.content_type = config.content_type
          hook.events = this.storedEvents(payload.events)
          if (typeof payload.active === 'boolean') hook.active = payload.active
          return Response.json(this.hookJson(hookId, hook))
        }
        if (method === 'DELETE') {
          this.hooks.delete(hookId)
          return new Response(null, { status: 204 })
        }
      }
      throw new Error(`fake gitea: unexpected ${method} ${url}`)
    }
  }
}
