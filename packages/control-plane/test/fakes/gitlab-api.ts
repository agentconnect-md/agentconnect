/**
 * Stateful fake gitlab.com edge for integration tests — the `FetchLike` twin of
 * the recording GitHub stubs (M2 test infrastructure). Serves OAuth token
 * exchange, the current user, project reads/search, effective membership, and
 * the §10.2 administration surface (service accounts, PATs, webhooks) with
 * scriptable failures. Grows with the milestones; the real-GitLab.com contract
 * suite stays §23's job.
 */
import type { FetchLike } from '../../src/gitlab/api.js'

export interface FakeGitlabOptions {
  projectId?: number
  path?: string
  accessLevel?: number
  namespaceKind?: 'group' | 'user'
  /** Refuse service-account creation (Owner verification / Free quota, §5). */
  refuseServiceAccountCreate?: boolean
  /** Return this expires_at instead of echoing the request (out-of-policy). */
  patExpiryOverride?: string | null
  /** Fail PAT revocations with a 500 (ambiguous cleanup). */
  failTokenRevoke?: boolean
}

export class FakeGitlab {
  readonly opts: Required<Pick<FakeGitlabOptions, 'projectId' | 'path' | 'accessLevel' | 'namespaceKind'>> &
    FakeGitlabOptions
  serviceAccounts: { id: number; username: string; name: string }[] = []
  tokens = new Map<number, { name: string; scopes: string[]; expires_at: string; revoked: boolean; user_id: number }>()
  webhooks = new Map<number, { url: string; token: string; events: Record<string, boolean>; tested: number }>()
  members = new Map<number, number>() // userId → access_level
  deletedServiceAccounts: number[] = []
  private nextId = 5000

  constructor(options: FakeGitlabOptions = {}) {
    this.opts = {
      projectId: options.projectId ?? 4455667,
      path: options.path ?? 'example-group/example-project',
      accessLevel: options.accessLevel ?? 50,
      namespaceKind: options.namespaceKind ?? 'group',
      ...options
    }
  }

  fetch(): FetchLike {
    return async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      const json = (): Record<string, unknown> => {
        try {
          return JSON.parse(body) as Record<string, unknown>
        } catch {
          return {}
        }
      }

      if (url.endsWith('/oauth/token')) {
        return Response.json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 7200,
          created_at: Math.floor(Date.now() / 1000),
          scope: 'api'
        })
      }
      if (url.endsWith('/oauth/revoke')) return Response.json({})
      if (url.endsWith('/api/v4/user')) return Response.json({ id: 4242, username: 'example-admin' })

      if (/\/api\/v4\/projects\/\d+\/members\/all\/\d+$/.test(url)) {
        const userId = Number(/members\/all\/(\d+)$/.exec(url)![1])
        const direct = this.members.get(userId)
        const level = direct ?? (userId === 4242 ? this.opts.accessLevel : null)
        if (level === null) return Response.json({ message: 'Not Found' }, { status: 404 })
        return Response.json({ access_level: level, state: 'active', expires_at: null })
      }
      if (/\/api\/v4\/projects\/\d+\/members$/.test(url) && method === 'POST') {
        const payload = json()
        this.members.set(Number(payload.user_id), Number(payload.access_level))
        return Response.json({ id: payload.user_id, access_level: payload.access_level, state: 'active' })
      }
      if (/\/api\/v4\/projects\/\d+\/members\/\d+$/.test(url) && method === 'PUT') {
        const userId = Number(/members\/(\d+)$/.exec(url)![1])
        this.members.set(userId, Number(json().access_level))
        return Response.json({ id: userId, access_level: json().access_level, state: 'active' })
      }

      if (/\/api\/v4\/projects\/\d+\/hooks$/.test(url) && method === 'POST') {
        const id = ++this.nextId
        const payload = json()
        this.webhooks.set(id, {
          url: String(payload.url),
          token: String(payload.signing_token),
          events: payload as Record<string, boolean>,
          tested: 0
        })
        return Response.json({ id, url: payload.url })
      }
      if (/\/api\/v4\/projects\/\d+\/hooks\/\d+\/test\/\w+$/.test(url) && method === 'POST') {
        const id = Number(/hooks\/(\d+)\/test/.exec(url)![1])
        const hook = this.webhooks.get(id)
        if (!hook) return Response.json({ message: 'Not Found' }, { status: 404 })
        hook.tested += 1
        return Response.json({})
      }
      if (/\/api\/v4\/projects\/\d+\/hooks\/\d+$/.test(url)) {
        const id = Number(/hooks\/(\d+)$/.exec(url)![1])
        if (method === 'DELETE') {
          if (!this.webhooks.delete(id)) return Response.json({ message: 'Not Found' }, { status: 404 })
          return Response.json({})
        }
        if (method === 'PUT') {
          const payload = json()
          this.webhooks.set(id, {
            url: String(payload.url),
            token: String(payload.signing_token),
            events: payload as Record<string, boolean>,
            tested: this.webhooks.get(id)?.tested ?? 0
          })
          return Response.json({ id, url: payload.url })
        }
      }

      if (/\/api\/v4\/projects\/\d+$/.test(url)) {
        const id = Number(/projects\/(\d+)$/.exec(url)![1])
        return Response.json({
          id,
          path_with_namespace: this.opts.path,
          default_branch: 'main',
          http_url_to_repo: `https://gitlab.com/${this.opts.path}.git`,
          namespace: {
            id: 900,
            parent_id: null,
            kind: this.opts.namespaceKind,
            full_path: this.opts.path.split('/')[0]!
          }
        })
      }
      if (url.includes('/api/v4/projects?')) {
        return Response.json([
          {
            id: this.opts.projectId,
            path_with_namespace: this.opts.path,
            default_branch: 'main',
            last_activity_at: '2026-08-20T00:00:00.000Z'
          }
        ])
      }

      if (/\/api\/v4\/groups\/\d+\/service_accounts\?/.test(url)) {
        return Response.json(this.serviceAccounts)
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts$/.test(url) && method === 'POST') {
        if (this.opts.refuseServiceAccountCreate) {
          return Response.json({ message: 'forbidden' }, { status: 403 })
        }
        const payload = json()
        const account = { id: ++this.nextId, username: String(payload.username), name: String(payload.name) }
        this.serviceAccounts.push(account)
        return Response.json(account, { status: 201 })
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts\/\d+$/.test(url) && method === 'DELETE') {
        const id = Number(/service_accounts\/(\d+)$/.exec(url)![1])
        this.deletedServiceAccounts.push(id)
        this.serviceAccounts = this.serviceAccounts.filter((account) => account.id !== id)
        return Response.json({})
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts\/\d+\/personal_access_tokens$/.test(url) && method === 'POST') {
        const userId = Number(/service_accounts\/(\d+)\//.exec(url)![1])
        const payload = json()
        const id = ++this.nextId
        const expires = this.opts.patExpiryOverride !== undefined ? this.opts.patExpiryOverride : payload.expires_at
        this.tokens.set(id, {
          name: String(payload.name),
          scopes: payload.scopes as string[],
          expires_at: String(expires),
          revoked: false,
          user_id: userId
        })
        return Response.json(
          {
            id,
            name: payload.name,
            scopes: payload.scopes,
            active: true,
            revoked: false,
            expires_at: expires,
            user_id: userId,
            token: `glpat-${id}`
          },
          { status: 201 }
        )
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts\/\d+\/personal_access_tokens\?/.test(url)) {
        const userId = Number(/service_accounts\/(\d+)\//.exec(url)![1])
        return Response.json(
          [...this.tokens.entries()]
            .filter(([, t]) => t.user_id === userId)
            .map(([id, t]) => ({ id, ...t, active: !t.revoked }))
        )
      }
      if (
        /\/api\/v4\/groups\/\d+\/service_accounts\/\d+\/personal_access_tokens\/\d+$/.test(url) &&
        method === 'DELETE'
      ) {
        if (this.opts.failTokenRevoke) return Response.json({ message: 'error' }, { status: 500 })
        const userId = Number(/service_accounts\/(\d+)\//.exec(url)![1])
        const id = Number(/personal_access_tokens\/(\d+)$/.exec(url)![1])
        const token = this.tokens.get(id)
        // Group-scoped authority: only the owning service account's tokens resolve.
        if (!token || token.user_id !== userId) return Response.json({ message: 'Not Found' }, { status: 404 })
        token.revoked = true
        return new Response(null, { status: 204 })
      }
      if (/\/api\/v4\/namespaces\/\d+$/.test(url)) {
        return Response.json({ id: 900, parent_id: null, kind: this.opts.namespaceKind, full_path: 'example-group' })
      }
      throw new Error(`fake gitlab: unexpected ${method} ${url}`)
    }
  }
}
