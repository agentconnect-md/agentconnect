/**
 * `http/routes/skill-sources.ts` (design docs/designs/shared-skills.md §4).
 *
 * CRUD for org-level shared-skills sources. A source records only WHERE skills
 * come from (a bounded public GitHub repository/tree path) plus its numeric
 * repository identity, optional ref, and skill filter — skill CONTENT never
 * touches the CP. The numeric identity is the CP's to resolve, not the client's:
 * projection drops a source without one, so a write that cannot bind it is
 * refused here instead of producing a row that looks enabled and installs
 * nothing (issue #935). The daemon acquires a commit-bound snapshot and installs it
 * with its bundled exact CLI before the ACP host spawns.
 *
 * There is NO secret side-table and NO grant (unlike MCP providers): skills carry
 * no upstream credential. This release supports PUBLIC sources only — a private
 * repo has no daemon authorization path yet, so create rejects a confirmed-private
 * source (a dedicated read-only grant is a follow-up). The definition is not pushed
 * on its own frame either — it
 * rides INLINE on each enabling agent's AgentSpec.skills (resolved by
 * agentSpecAssembler). So a source change fans out to `agent/upsert` for every
 * agent that references it (§4 trade-off).
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { normalizeGitHubSkillSource } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { AgentRecord, SkillSourceRecord } from '../../persistence/ports.js'
import type { OrgId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { parseSkillRef } from '../../orchestrator/skillSource.js'
import {
  CreateSkillSourceBody,
  UpdateSkillSourceBody,
  PreviewSkillSourceBody,
  SkillSourcePreviewDto,
  SkillSourceSkillsDto,
  SkillRegistrySearchQuery,
  SkillRegistrySearchDto,
  SkillSourceDto,
  SkillSourceListDto,
  SetSharingBody,
  ErrorDto,
  IdParam,
  type SkillSourceDtoT
} from '../dto/index.js'

/*
 * Reference-sensitive skill-source lifecycle operations serialize on the
 * (orgId, name) ADVISORY LOCK SCOPE (persistence/skill-source-lock.ts), taken
 * inside the repository transactions: the DELETE's reference scan → row drop,
 * the create-side name-capture guard, sharing flips, and every agent write
 * whose submitted enable-list references the source (the skillSources fence in
 * routes/agents.ts) each hold the scope for their check-then-write pair, so a
 * reference can neither appear under a dying source nor bind to an invisible
 * replacement — across control-plane instances (rolling updates included),
 * where the per-process promise chain this replaced could not reach.
 */

/** Extract `{owner, repo, ref?, subDir?}` from a source string. Decomposes the
 *  value the SHARED grammar already accepted (`normalizeGitHubSkillSource` — the
 *  same refinement `SkillSourceArg` enforces) rather than re-deriving the accepted
 *  set here: binding is mandatory, so any form this missed would be a source the
 *  DTO admits and the route then rejects. Null ⇒ not a GitHub source at all. */
function parseGithubRepo(source: string): { owner: string; repo: string; ref?: string; subDir?: string } | null {
  let normalized: string
  try {
    normalized = normalizeGitHubSkillSource(source)
  } catch {
    return null
  }
  // scp form (`git@github.com:owner/repo`) carries its path after the colon and is
  // not a parseable URL; every other accepted form is absolute by now.
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(normalized)
  let parts: string[]
  try {
    parts = (scp ? scp[1]! : new URL(normalized).pathname.slice(1)).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  const owner = parts[0]
  const repo = parts[1]?.replace(/\.git$/i, '')
  if (!owner || !repo) return null
  // The grammar admits owner/repo or owner/repo/tree/<ref>[/<subdir>] (https only).
  const ref = parts[2] === 'tree' ? parts[3] : undefined
  const subDir = ref && parts.length > 4 ? parts.slice(4).join('/') : undefined
  return { owner, repo, ...(ref ? { ref } : {}), ...(subDir ? { subDir } : {}) }
}

/**
 * Rewrite the owner/repo half of a source to GitHub's canonical `full_name`,
 * preserving whatever else the string carries (`.git`, `/tree/<ref>/<subdir>`).
 *
 * GitHub follows rename and transfer REDIRECTS: `GET /repos/docker/docker` answers
 * 200 with `full_name: moby/moby`. Persisting the typed slug next to the resolved
 * numeric id would then fail on the daemon, whose identity check requires
 * `full_name` to equal the configured source — the same visible-but-uninstallable
 * state this binding exists to remove, just louder. Null ⇒ the slug is not a
 * substring we can rewrite (percent-encoded owner/repo); the caller refuses the
 * write rather than store a mismatch.
 */
function canonicalizeSource(source: string, parsed: { owner: string; repo: string }, fullName: string): string | null {
  const slug = `${parsed.owner}/${parsed.repo}`
  if (slug.toLowerCase() === fullName.toLowerCase()) return source
  const at = source.toLowerCase().indexOf(slug.toLowerCase())
  return at < 0 ? null : source.slice(0, at) + fullName + source.slice(at + slug.length)
}

/** What one repo lookup can conclude. `unreachable` (GitHub down, rate limited) is
 *  retryable and must not be confused with `not-found`, which is a verdict. */
type RepoBinding =
  | {
      status: 'ok'
      repoId: bigint
      fullName: string
      /** The stored source rewritten to `fullName`; null ⇒ it names a repo that has
       *  since been renamed and the slug cannot be rewritten in place. */
      canonicalSource: string | null
      private: boolean
      defaultBranch: string
    }
  | { status: 'not-found' | 'unreachable' | 'unparseable' }

function toDto(s: SkillSourceRecord, ctx: ViewCtx): SkillSourceDtoT {
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    githubRepoId: s.githubRepoId !== null ? s.githubRepoId.toString() : null,
    ref: s.ref,
    subDir: s.subDir,
    skills: s.skills,
    visibility: s.visibility,
    sharedWith: s.sharedWith,
    createdBy: s.createdByUserId,
    canEdit: canEdit(s, ctx),
    canManageSharing: canManageSharing(s, ctx),
    createdAt: s.createdAt.toISOString()
  }
}

/** Parse the optional numeric github repo id carried as a string on the wire. */
function parseRepoId(raw: string | null | undefined): bigint | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  try {
    return BigInt(raw)
  } catch {
    return undefined
  }
}

export function skillSourceRoutes(deps: HttpDeps) {
  return async function skillSourceRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // ONE lookup per write, answering everything a source write needs about the repo:
    // its rename-proof NUMERIC id (without which the row never projects onto an
    // AgentSpec — issue #935), whether it is private (rejected this release), and its
    // default branch (a subdir source must pin a ref; the daemon must not assume
    // `main`). The org installation answers first when it covers the owner; otherwise
    // the anonymous public read does, which is the only path for a skills.sh source.
    const resolveRepoBinding = async (orgId: OrgId, source: string): Promise<RepoBinding> => {
      const parsed = parseGithubRepo(source)
      if (!parsed) return { status: 'unparseable' }
      const found = async (): Promise<
        { repoId: bigint; fullName: string; private: boolean; defaultBranch: string } | 'not-found' | 'unreachable'
      > => {
        const gh = deps.github
        if (gh) {
          const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(orgId, parsed.owner)
          // An installation failure is not a verdict on a PUBLIC repo — fall through
          // to the anonymous read rather than treat the source as unbindable.
          const ref = ins ? await gh.repoRefFor(ins, parsed.owner, parsed.repo).catch(() => null) : null
          if (ref) return ref
        }
        const resolve = deps.resolvePublicRepo
        return resolve ? await resolve(parsed.owner, parsed.repo) : 'unreachable'
      }
      const hit = await found()
      if (typeof hit === 'string') return { status: hit }
      // Carry the CANONICAL source alongside the id: the two must agree, or the
      // daemon refuses the entry (see canonicalizeSource).
      return { status: 'ok', ...hit, canonicalSource: canonicalizeSource(source, parsed, hit.fullName) }
    }

    // Reject rather than persist a source whose identity we could not establish: an
    // unbound row looks enabled in the console but is silently dropped from every
    // projection, so it can never install anything (#935).
    const rejectUnbound = (reply: FastifyReply, binding: RepoBinding) =>
      binding.status === 'unreachable'
        ? reply.code(503).send(bindingUnavailable)
        : reply.code(400).send(binding.status === 'not-found' ? repoNotFound : notAGithubRepo)

    // Re-inline a source's definition onto every agent that enables it and push
    // the refreshed spec. Best-effort per agent (the register/ok roster is the
    // reconnect backstop), mirroring the agents route's replicateUpsert.
    const fanOutToReferrers = async (orgId: OrgId, sourceName: string): Promise<void> => {
      const agents = await deps.repos.agent.list(orgId)
      const referrers = agents.filter((a) => a.skills.some((ref) => parseSkillRef(ref).source === sourceName))
      for (const a of referrers) await replicate(a)
    }

    const replicate = (agent: AgentRecord): Promise<void> =>
      deps.agentDelivery.upsert(agent, (err, daemonId) => {
        if (err instanceof NoConnection) {
          app.log.debug({ agentId: agent.id, daemonId }, 'skill fan-out: daemon offline')
        } else {
          app.log.warn(
            { err, agentId: agent.id, daemonId },
            'skill fan-out agent/upsert failed (backstop: reconnect roster)'
          )
        }
      })

    r.get(
      '/skill-sources',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'List skill sources',
          description:
            'Every shared-skills source in the active organization (metadata only; content stays daemon-side).',
          operationId: 'listSkillSources',
          response: { 200: SkillSourceListDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const rows = await deps.repos.skillSource.listForOrg(orgOf(req), ctx)
        return rows.map((s) => toDto(s, ctx))
      }
    )

    // Search the public skills.sh index (the same index `npx skills find` reads) so
    // the console can install a skill BY NAME instead of hand-typing a repo. Pure
    // discovery: nothing is persisted here and the picked hit still goes through
    // POST /skill-sources. Declared before `/:id` for reading order only — the
    // static `registry` segment already outranks the parametric one in the router,
    // and no source id is ever the literal "registry".
    r.get(
      '/skill-sources/registry/search',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Search the skills.sh registry',
          description:
            'Look up installable skills by name in the public skills.sh index. Each hit carries the `owner/repo` source plus the skill directory name, ready to be registered with POST /skill-sources. Discovery only — nothing is persisted, and `reachable:false` (empty list) means the index could not be read rather than that nothing matched.',
          operationId: 'searchSkillRegistry',
          querystring: SkillRegistrySearchQuery,
          response: { 200: SkillRegistrySearchDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        // Registering a source is a write, so the discovery that feeds it follows the
        // same gate as the GitHub import preview: viewers don't get the search.
        if (denyViewerWrite(req, reply)) return
        const search = deps.searchSkillRegistry
        if (!search) return { reachable: false, skills: [] }
        const result = await search(req.query.q, {
          ...(req.query.owner ? { owner: req.query.owner } : {}),
          limit: req.query.limit
        })
        return result.status === 'ok' ? { reachable: true, skills: result.skills } : { reachable: false, skills: [] }
      }
    )

    r.get(
      '/skill-sources/:id',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Get a skill source',
          description: "Fetch a single skill source by id (scoped to the caller's org; a cross-org id reads as 404).",
          operationId: 'getSkillSource',
          params: IdParam,
          response: { 200: SkillSourceDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const s = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!s || !canView(s, ctxOf(req))) return notFound(reply)
        return toDto(s, ctxOf(req))
      }
    )

    r.get(
      '/skill-sources/:id/skills',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'List a skill source’s skills',
          description:
            'Best-effort scan of the source repo for its SKILL.md manifest, for the per-agent skill picker. Returns resolvable:false + an empty list when the source is not a scannable GitHub repo reachable by an installation (the UI then offers whole-source enablement only).',
          operationId: 'listSkillSourceSkills',
          params: IdParam,
          response: { 200: SkillSourceSkillsDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const s = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!s || !canView(s, ctxOf(req))) return notFound(reply)
        const gh = deps.github
        const parsed = parseGithubRepo(s.source)
        if (!gh || !parsed) return { resolvable: false, skills: [] }
        const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(orgOf(req), parsed.owner)
        if (!ins) return { resolvable: false, skills: [] }
        try {
          // Scan the SAME ref/subdir composeSource installs from, so the manifest
          // reflects the source's actual scope.
          const scan = await gh.scanSkillSource(
            ins,
            parsed.owner,
            parsed.repo,
            s.ref ?? parsed.ref,
            s.subDir ?? parsed.subDir
          )
          // Honor the source's own skill filter: never offer skills the resolver
          // would later drop (`resolveAgentSkillEntries` intersects with s.skills).
          const allowed = s.skills.length > 0 ? new Set(s.skills) : null
          const skills = allowed ? scan.skills.filter((sk) => allowed.has(sk.name)) : scan.skills
          return { resolvable: true, skills }
        } catch {
          return { resolvable: false, skills: [] }
        }
      }
    )

    r.post(
      '/skill-sources/preview',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Preview a GitHub skill source',
          description:
            'Best-effort scan of a repo for the import dialog: branch + tag choices and the SKILL.md manifest. Requires a GitHub App installation reachable by the caller; scan failure yields an empty skill list (install all).',
          operationId: 'previewSkillSource',
          body: PreviewSkillSourceBody,
          response: { 200: SkillSourcePreviewDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const gh = deps.github
        if (!gh) return notFound(reply) // github-app feature off — no scan possible
        const ins = await deps.repos.githubInstallation.get(orgOf(req), req.body.installationId)
        if (!ins || ins.revokedAt) return notFound(reply)
        const [branches, scan] = await Promise.all([
          gh.listBranches(ins, req.body.owner, req.body.repo).catch(() => [] as string[]),
          gh.scanSkillSource(ins, req.body.owner, req.body.repo, req.body.ref)
        ])
        return { branches, tags: scan.tags, skills: scan.skills }
      }
    )

    r.post(
      '/skill-sources',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Register a skill source',
          description:
            'Register an org-level public GitHub skill source. The numeric repository identity is resolved server-side (org installation first, then a public read), so no client needs to know it; `githubRepoId` in the body only overrides that lookup. A repository that cannot be identified is rejected — 400 when GitHub says it does not exist, 503 while GitHub is unreachable — rather than persisted as a row the projection would silently drop. The daemon acquires a bounded local snapshot; the remote source is never passed to the CLI. `skills` empty ⇒ install every skill the snapshot exposes. Rejected with 409 while any agent already enables skills under the requested source name — agents bind by name, so a new source must not silently capture existing selections.',
          operationId: 'createSkillSource',
          body: CreateSkillSourceBody,
          response: {
            201: SkillSourceDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const sharedWith =
          req.body.visibility === 'restricted' && req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
            : undefined
        const binding = await resolveRepoBinding(orgOf(req), req.body.source)
        // Scope this release to PUBLIC sources: the daemon has no authorization path to
        // clone a private skill repo yet (a dedicated read-only grant is a follow-up).
        if (binding.status === 'ok' && binding.private) return reply.code(400).send(privateNotSupported)
        // Bind the numeric identity server-side. A client-supplied id still wins (it is
        // the same fact, already verified by the daemon before acquisition), but no
        // client has to know it — which is what made every console-created source
        // non-installable (#935).
        const repoId = parseRepoId(req.body.githubRepoId) ?? (binding.status === 'ok' ? binding.repoId : undefined)
        if (repoId === undefined) return rejectUnbound(reply, binding)
        // Store the slug GitHub redirected us to, not the one that was typed: the
        // daemon requires the two to agree before it will acquire anything.
        const source = binding.status === 'ok' && repoId === binding.repoId ? binding.canonicalSource : req.body.source
        if (source === null) return reply.code(400).send(renamedRepo)
        const ref = req.body.ref ?? (req.body.subDir && binding.status === 'ok' ? binding.defaultBranch : undefined)
        // A subdir source needs a ref; if we couldn't resolve one reject rather than
        // let the daemon assume `main`.
        if (req.body.subDir && !ref) return reply.code(400).send(subdirNeedsRef)
        // Name-capture guard — the mirror image of the delete guard: agents bind
        // by NAME, so registering a source under a name agents already enable
        // would capture their installs onto this new source without any per-agent
        // consent. The repo refuses while referenced (null), with the reference
        // scan and the insert in one transaction under the (orgId, name) advisory
        // scope — atomic against enable-list writes and a same-name delete.
        const created = await deps.repos.skillSource.create({
          orgId: orgOf(req),
          name: req.body.name,
          source,
          githubRepoId: repoId,
          ...(ref !== undefined ? { ref } : {}),
          ...(req.body.subDir !== undefined ? { subDir: req.body.subDir } : {}),
          skills: req.body.skills,
          ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
          ...(sharedWith ? { sharedWith } : {}),
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
        if (!created) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message:
              'an agent already enables skills from a source with this name; unselect it there first or pick another name'
          })
        }
        return reply.code(201).send(toDto(created, ctxOf(req)))
      }
    )

    r.patch(
      '/skill-sources/:id',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Update a skill source',
          description:
            'Edit a source’s source string, ref, subdir, or skill filter. `skills` replaces the stored filter wholesale. Name is immutable (agents bind by name; recreate to rename). Changes re-push every agent that enables this source. The numeric repository identity is re-resolved when the source changes or the row never had one — which is how a historical unbound row is repaired — and clearing it is refused, since an unbound source can never install.',
          operationId: 'updateSkillSource',
          params: IdParam,
          body: UpdateSkillSourceBody,
          response: { 200: SkillSourceDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!existing || !canView(existing, ctxOf(req))) return notFound(reply)
        if (req.body.githubRepoId === null) return reply.code(400).send(unbindNotAllowed)
        const effSource = req.body.source ?? existing.source
        const binding = await resolveRepoBinding(orgOf(req), effSource)
        // Same public-only guard as create, on the EFFECTIVE source — a PATCH that
        // points an existing source at a (now-confirmed) private repo is rejected too.
        if (binding.status === 'ok' && binding.private) return reply.code(400).send(privateNotSupported)
        // Re-bind when the identity would otherwise be wrong or missing: a changed
        // source, or a historical row that never got one. This is what repairs the
        // NULL rows already in the wild — PATCH had no way to fix them (#935). An
        // unchanged, already-bound row is left alone, so an unrelated `skills` edit
        // still succeeds while GitHub is unreachable.
        const rebind = req.body.source !== undefined && req.body.source !== existing.source
        const repoId =
          parseRepoId(req.body.githubRepoId) ??
          (rebind || existing.githubRepoId === null
            ? binding.status === 'ok'
              ? binding.repoId
              : undefined
            : existing.githubRepoId)
        if (repoId === undefined) return rejectUnbound(reply, binding)
        // Persist the canonical slug whenever this write bound the id — including a
        // back-fill, where the stored source may name a repo that has since moved.
        const bound = binding.status === 'ok' && repoId === binding.repoId
        const canonicalSource = bound ? binding.canonicalSource : effSource
        if (canonicalSource === null) return reply.code(400).send(renamedRepo)
        // Preserve an explicit ref across an unrelated PATCH: only resolve a default
        // branch when the EFFECTIVE ref is absent (untouched-and-existing counts as
        // present), so a `skills`-only edit can't silently rewrite the pinned ref.
        const refTouched = req.body.ref !== undefined
        const currentRef = refTouched ? (req.body.ref ?? undefined) : (existing.ref ?? undefined)
        const effSubDir =
          req.body.subDir === undefined ? (existing.subDir ?? undefined) : (req.body.subDir ?? undefined)
        const resolvedRef = currentRef ?? (effSubDir && binding.status === 'ok' ? binding.defaultBranch : undefined)
        // A subdir source needs a ref; reject if we couldn't resolve one rather than
        // let the daemon assume `main`.
        if (effSubDir && !resolvedRef) return reply.code(400).send(subdirNeedsRef)
        const source = await deps.repos.skillSource.update(orgOf(req), existing.id, {
          ...(canonicalSource !== existing.source ? { source: canonicalSource } : {}),
          githubRepoId: repoId,
          ...(resolvedRef !== undefined
            ? { ref: resolvedRef }
            : refTouched && req.body.ref === null
              ? { ref: null }
              : {}),
          ...(req.body.subDir !== undefined ? { subDir: req.body.subDir } : {}),
          ...(req.body.skills !== undefined ? { skills: req.body.skills } : {})
        })
        await fanOutToReferrers(orgOf(req), source.name)
        return toDto(source, ctxOf(req))
      }
    )

    r.put(
      '/skill-sources/:id/sharing',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Set skill source sharing',
          description:
            'Set a skill source’s visibility (Everyone vs Selected) and complete Selected audience. Requires edit rights; Selected must retain at least one current organization member, and sharedWith is intersected with current membership.',
          operationId: 'setSkillSourceSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: SkillSourceDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!existing || !canView(existing, ctxOf(req))) return notFound(reply)
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        // The repo writes under the (orgId, name) advisory scope: agent
        // enable-list writes authorize against source visibility inside the same
        // scope (routes/agents.ts), so this flip cannot land between their check
        // and their commit.
        const source = await deps.repos.skillSource.setSharing(
          orgOf(req),
          existing.id,
          {
            visibility: req.body.visibility,
            sharedWith
          },
          req.principal?.userId
        )
        return toDto(source, ctxOf(req))
      }
    )

    r.delete(
      '/skill-sources/:id',
      {
        schema: {
          tags: [Tag.Skills],
          summary: 'Delete a skill source',
          description:
            'Delete a skill source. Rejected with 409 while any agent still enables it — unselect it from those agents first.',
          operationId: 'deleteSkillSource',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!existing || !canView(existing, ctxOf(req))) return notFound(reply)
        // Agents bind a source by NAME (their enable-refs), so deleting while
        // referenced would leave dangling selectors that silently re-bind to any
        // future source recreated under the same name. The repo runs the
        // reference scan and the row drop in one transaction under the
        // (orgId, name) advisory scope, which agent enable-list writes and
        // same-name creates take too (the skillSources fence in routes/agents.ts,
        // the create guard above): a concurrent enable cannot slip a reference in
        // between the scan and the drop — it either commits first (we 409) or
        // serializes after the drop (its in-scope visibility check then refuses
        // the now-unknown name, and the create guard keeps the name uncapturable
        // while referenced).
        const outcome = await deps.repos.skillSource.delete(orgOf(req), existing.id)
        if (outcome === 'referenced') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'skill source is still enabled by one or more agents; unselect it there first'
          })
        }
        return reply.code(204).send(null)
      }
    )
  }
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'skill source not found' })
}

const subdirNeedsRef = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'a subdir skill source needs a ref; provide one, or ensure the org GitHub App can reach the repo'
}

const privateNotSupported = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'private skill sources are not supported yet — use a public repository'
}

const repoNotFound = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'no such public GitHub repository — a source that cannot be identified can never install'
}

const notAGithubRepo = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'source must name a GitHub repository so its numeric identity can be bound'
}

const bindingUnavailable = {
  error: 'Service Unavailable',
  statusCode: 503,
  message: 'could not reach GitHub to identify the repository — retry shortly'
}

const renamedRepo = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'the repository has been renamed or transferred; register it under its current owner/repository name'
}

/** An explicit `githubRepoId: null` asks for exactly the state #935 is about. */
const unbindNotAllowed = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'githubRepoId cannot be cleared — an unbound source is never installable'
}
