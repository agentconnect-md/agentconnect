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
  /** Refuse service-account creation (Owner verification, §5). */
  refuseServiceAccountCreate?: boolean
  /** Refuse service-account creation for the root's 100-account quota (§7.2). */
  refuseServiceAccountQuota?: boolean
  /** Return this expires_at instead of echoing the request (out-of-policy). */
  patExpiryOverride?: string | null
  /** Fail PAT revocations with a 500 (ambiguous cleanup). */
  failTokenRevoke?: boolean
  /** Refuse the display-name rename (older provider, or a locked account). */
  refuseServiceAccountRename?: boolean
  /** Create the account, then fail the response — the ambiguous create (§7.2). */
  ambiguousServiceAccountCreate?: boolean
  /** Refuse the username convergence specifically (the name is taken). */
  refuseServiceAccountUsernameChange?: boolean
  /** Observe the row the moment the provider sees a service-account PATCH. */
  onServiceAccountPatch?: () => Promise<void>
  /** Act between the pages of a service-account listing — a peer that moves
   *  while an exhaustive read is in flight (§7.2). */
  onServiceAccountListPage?: (page: number) => Promise<void>
  /** Answer the avatar endpoint 404 — a provider that does not offer it. */
  avatarEndpointUnsupported?: boolean
  /** Refuse the avatar upload with a definitive 400. */
  refuseAvatarUpload?: boolean
}

/** GitLab-shaped paging: one `per_page` slice plus `x-next-page`, empty on the
 *  last page. Listings the recovery predicates read must follow it (§7.2). */
function page<T>(url: string, rows: readonly T[]): Response {
  const params = new URL(url).searchParams
  const perPage = Number(params.get('per_page') ?? '20')
  const index = Number(params.get('page') ?? '1')
  const next = index * perPage < rows.length ? String(index + 1) : ''
  return Response.json(rows.slice((index - 1) * perPage, index * perPage), { headers: { 'x-next-page': next } })
}

export class FakeGitlab {
  readonly opts: Required<Pick<FakeGitlabOptions, 'projectId' | 'path' | 'accessLevel' | 'namespaceKind'>> &
    FakeGitlabOptions
  serviceAccounts: { id: number; username: string; name: string }[] = []
  tokens = new Map<number, { name: string; scopes: string[]; expires_at: string; revoked: boolean; user_id: number }>()
  webhooks = new Map<
    number,
    { projectId: number; url: string; token: string; events: Record<string, boolean>; tested: number }
  >()
  members = new Map<number, number>() // userId → access_level
  removedMembers: number[] = []
  /** §16.1 rerun subjects, by IID. `headSha` is what a live read reports NOW. */
  mergeRequests = new Map<number, { state: string; headSha: string; baseSha?: string; draft?: boolean }>()
  issues = new Map<number, { state: string }>()
  deletedServiceAccounts: number[] = []
  /** Every accepted `PUT /user/avatar`, by the PAT that presented it (§7.3:
   *  only an account's own `api` token may wear its avatar). */
  avatarUploads: { token: string | null; bytes: number }[] = []
  /** Every call the CP made, with the bearer it presented — WHICH token a check
   *  used is part of the contract (§9.4 takeover proves the caller's own access). */
  requests: { method: string; url: string; token: string | null }[] = []
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
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization
      this.requests.push({ method, url, token: authorization?.replace(/^Bearer /, '') ?? null })
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
      if (/\/api\/v4\/projects\/\d+\/members\/\d+$/.test(url) && method === 'GET') {
        // The DIRECT membership read: this fake tracks only direct rows.
        const userId = Number(/members\/(\d+)$/.exec(url)![1])
        const level = this.members.get(userId)
        if (level === undefined) return Response.json({ message: 'Not Found' }, { status: 404 })
        return Response.json({ id: userId, access_level: level, state: 'active' })
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
      if (/\/api\/v4\/projects\/\d+\/members\/\d+$/.test(url) && method === 'DELETE') {
        const userId = Number(/members\/(\d+)$/.exec(url)![1])
        if (!this.members.delete(userId)) return Response.json({ message: 'Not Found' }, { status: 404 })
        this.removedMembers.push(userId)
        return new Response(null, { status: 204 })
      }

      if (/\/api\/v4\/projects\/\d+\/hooks\?/.test(url) && method === 'GET') {
        const projectId = Number(/projects\/(\d+)\//.exec(url)![1])
        // Real GitLab scopes the listing to the addressed project.
        return page(
          url,
          [...this.webhooks.entries()]
            .filter(([, hook]) => hook.projectId === projectId)
            .map(([id, hook]) => ({ id, url: hook.url }))
        )
      }
      if (/\/api\/v4\/projects\/\d+\/hooks$/.test(url) && method === 'POST') {
        const projectId = Number(/projects\/(\d+)\//.exec(url)![1])
        const id = ++this.nextId
        const payload = json()
        this.webhooks.set(id, {
          projectId,
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
        const projectId = Number(/projects\/(\d+)\//.exec(url)![1])
        const id = Number(/hooks\/(\d+)$/.exec(url)![1])
        // Project-scoped authority: another project's hook id resolves 404.
        if (this.webhooks.get(id)?.projectId !== projectId) {
          return Response.json({ message: 'Not Found' }, { status: 404 })
        }
        if (method === 'DELETE') {
          this.webhooks.delete(id)
          return Response.json({})
        }
        if (method === 'PUT') {
          const payload = json()
          this.webhooks.set(id, {
            projectId,
            url: String(payload.url),
            token: String(payload.signing_token),
            events: payload as Record<string, boolean>,
            tested: this.webhooks.get(id)?.tested ?? 0
          })
          return Response.json({ id, url: payload.url })
        }
      }

      if (/\/api\/v4\/projects\/\d+\/merge_requests\/\d+$/.test(url) && method === 'GET') {
        const iid = Number(/merge_requests\/(\d+)$/.exec(url)![1])
        const mr = this.mergeRequests.get(iid)
        if (!mr) return Response.json({ message: 'Not Found' }, { status: 404 })
        const projectId = Number(/projects\/(\d+)\//.exec(url)![1])
        return Response.json({
          iid,
          state: mr.state,
          title: `merge request ${iid}`,
          web_url: `https://gitlab.com/${this.opts.path}/-/merge_requests/${iid}`,
          draft: mr.draft ?? false,
          sha: mr.headSha,
          source_project_id: projectId,
          target_project_id: projectId,
          diff_refs: { base_sha: mr.baseSha ?? null, head_sha: mr.headSha, start_sha: mr.baseSha ?? null }
        })
      }
      if (/\/api\/v4\/projects\/\d+\/issues\/\d+$/.test(url) && method === 'GET') {
        const iid = Number(/issues\/(\d+)$/.exec(url)![1])
        const issue = this.issues.get(iid)
        if (!issue) return Response.json({ message: 'Not Found' }, { status: 404 })
        return Response.json({
          iid,
          state: issue.state,
          title: `issue ${iid}`,
          web_url: `https://gitlab.com/${this.opts.path}/-/issues/${iid}`
        })
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
        await this.opts.onServiceAccountListPage?.(Number(new URL(url).searchParams.get('page') ?? '1'))
        return page(url, this.serviceAccounts)
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts$/.test(url) && method === 'POST') {
        if (this.opts.refuseServiceAccountQuota) {
          return Response.json({ message: 'Maximum number of service accounts reached' }, { status: 400 })
        }
        if (this.opts.refuseServiceAccountCreate) {
          return Response.json({ message: 'forbidden' }, { status: 403 })
        }
        const payload = json()
        const username = String(payload.username)
        if (this.serviceAccounts.some((existing) => existing.username === username)) {
          return Response.json({ message: 'Username has already been taken' }, { status: 409 })
        }
        const account = { id: ++this.nextId, username, name: String(payload.name) }
        this.serviceAccounts.push(account)
        // The account landed but the answer did not — what recovery must survive.
        if (this.opts.ambiguousServiceAccountCreate) {
          return Response.json({ message: 'gateway timeout' }, { status: 504 })
        }
        return Response.json(account, { status: 201 })
      }
      if (/\/api\/v4\/groups\/\d+\/service_accounts\/\d+$/.test(url) && method === 'PATCH') {
        const id = Number(/service_accounts\/(\d+)$/.exec(url)![1])
        const account = this.serviceAccounts.find((candidate) => candidate.id === id)
        if (!account) return Response.json({ message: 'Not Found' }, { status: 404 })
        if (this.opts.refuseServiceAccountRename) return Response.json({ message: 'forbidden' }, { status: 403 })
        await this.opts.onServiceAccountPatch?.()
        const patch = json()
        if (typeof patch.username === 'string') {
          if (this.opts.refuseServiceAccountUsernameChange) {
            return Response.json({ message: 'Username has already been taken' }, { status: 409 })
          }
          if (this.serviceAccounts.some((other) => other.id !== id && other.username === patch.username)) {
            return Response.json({ message: 'Username has already been taken' }, { status: 409 })
          }
          account.username = patch.username
        }
        if (typeof patch.name === 'string') account.name = patch.name
        return Response.json(account)
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
        return page(
          url,
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
      if (url.endsWith('/api/v4/user/avatar') && method === 'PUT') {
        if (this.opts.avatarEndpointUnsupported) return Response.json({ message: '404 Not Found' }, { status: 404 })
        if (this.opts.refuseAvatarUpload) return Response.json({ message: 'avatar is invalid' }, { status: 400 })
        const form = init?.body instanceof FormData ? init.body : null
        const file = form?.get('avatar')
        if (!(file instanceof Blob)) return Response.json({ message: 'avatar is missing' }, { status: 400 })
        this.avatarUploads.push({
          token: authorization?.replace(/^Bearer /, '') ?? null,
          bytes: file.size
        })
        return Response.json({ id: 1, avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png' })
      }
      if (/\/api\/v4\/namespaces\/\d+$/.test(url)) {
        return Response.json({ id: 900, parent_id: null, kind: this.opts.namespaceKind, full_path: 'example-group' })
      }
      throw new Error(`fake gitlab: unexpected ${method} ${url}`)
    }
  }
}
