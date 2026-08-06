/**
 * `http/routes/skill-sources.ts` (design docs/designs/shared-skills.md §4).
 *
 * CRUD for org-level shared-skills sources. A source records only WHERE skills
 * come from (a bounded public GitHub repository/tree path) plus its numeric
 * repository identity, optional ref, and skill filter — skill CONTENT never
 * touches the CP. The daemon acquires a commit-bound snapshot and installs it
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

/** Extract `{owner, repo, ref?}` from a source string (shorthand, https, or ssh
 *  GitHub form). Returns null for a non-GitHub / unparseable source. */
function parseGithubRepo(source: string): { owner: string; repo: string; ref?: string; subDir?: string } | null {
  const s = source.trim().replace(/\.git$/, '')
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?/i.exec(s)
  if (m) return { owner: m[1]!, repo: m[2]!, ...(m[3] ? { ref: m[3] } : {}), ...(m[4] ? { subDir: m[4] } : {}) }
  m = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(s)
  if (m) return { owner: m[1]!, repo: m[2]! }
  m = /^([^/\s:]+)\/([^/\s]+)$/.exec(s)
  if (m) return { owner: m[1]!, repo: m[2]! }
  return null
}

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

    // A `subDir` source needs a ref (the CLI's tree/<ref>/<subdir> form requires one),
    // and the daemon must not assume `main`. When a subdir is given without a ref,
    // resolve the repo's ACTUAL default branch here and persist it as the ref. Returns
    // the ref unchanged when there's nothing to resolve (no subdir, ref already set,
    // non-GitHub source, or no installation).
    const resolveRefForSubdir = async (
      orgId: OrgId,
      source: string,
      ref: string | undefined,
      subDir: string | undefined
    ): Promise<string | undefined> => {
      if (ref || !subDir) return ref
      const gh = deps.github
      const parsed = parseGithubRepo(source)
      if (!gh || !parsed) return ref
      const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(orgId, parsed.owner)
      if (!ins) return ref
      const meta = await gh.getRepoMeta(ins, parsed.owner, parsed.repo).catch(() => null)
      return meta?.defaultBranch ?? ref
    }

    // True only when we can CONFIRM the source repo is private (GitHub source + org
    // installation + a readable meta saying private). Unknown ⇒ false (treated public).
    const isPrivateRepo = async (orgId: OrgId, source: string): Promise<boolean> => {
      const gh = deps.github
      const parsed = parseGithubRepo(source)
      if (!gh || !parsed) return false
      const ins = await deps.repos.githubInstallation.liveByOrgAndAccount(orgId, parsed.owner)
      if (!ins) return false
      const meta = await gh.getRepoMeta(ins, parsed.owner, parsed.repo).catch(() => null)
      return meta?.private === true
    }

    // Re-inline a source's definition onto every agent that enables it and push
    // the refreshed spec. Best-effort per agent (the register/ok roster is the
    // reconnect backstop), mirroring the agents route's replicateUpsert.
    const fanOutToReferrers = async (orgId: OrgId, sourceName: string): Promise<void> => {
      const agents = await deps.repos.agent.list(orgId)
      const referrers = agents.filter(
        (a) => a.daemonId && a.skills.some((ref) => parseSkillRef(ref).source === sourceName)
      )
      for (const a of referrers) await replicate(a)
    }

    const replicate = async (agent: AgentRecord): Promise<void> => {
      if (!agent.daemonId) return
      const spec = await deps.agentSpecs.assemble(agent)
      try {
        await deps.control.agentUpsert(agent.daemonId, { agentId: agent.id, spec })
      } catch (err) {
        if (err instanceof NoConnection) {
          app.log.debug({ agentId: agent.id, daemonId: agent.daemonId }, 'skill fan-out: daemon offline')
        } else {
          app.log.warn({ err, agentId: agent.id }, 'skill fan-out agent/upsert failed (backstop: reconnect roster)')
        }
      }
    }

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
        const ins = await deps.repos.githubInstallation.get(req.body.installationId)
        if (!ins || ins.orgId !== orgOf(req) || ins.revokedAt) return notFound(reply)
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
            'Register an org-level public GitHub skill source and numeric repository identity. An omitted migration-compatible identity leaves the row visible but non-installable until bound: projection omits it from AgentSpec. The daemon acquires a bounded local snapshot; the remote source is never passed to the CLI. `skills` empty ⇒ install every skill the snapshot exposes. Rejected with 409 while any agent already enables skills under the requested source name — agents bind by name, so a new source must not silently capture existing selections.',
          operationId: 'createSkillSource',
          body: CreateSkillSourceBody,
          response: { 201: SkillSourceDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const sharedWith =
          req.body.visibility === 'restricted' && req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
            : undefined
        const repoId = parseRepoId(req.body.githubRepoId)
        // Scope this release to PUBLIC sources: the daemon has no authorization path to
        // clone a private skill repo yet (a dedicated read-only grant is a follow-up).
        // Reject a source we can confirm is private rather than silently accept one that
        // can never install. Undeterminable privacy (no installation) is allowed through
        // as public — a private repo with no installation can't be scanned/cloned anyway.
        if (await isPrivateRepo(orgOf(req), req.body.source)) return reply.code(400).send(privateNotSupported)
        const ref = await resolveRefForSubdir(orgOf(req), req.body.source, req.body.ref, req.body.subDir)
        // A subdir source needs a ref; if we couldn't resolve one (owner has no org
        // installation, non-GitHub source) reject rather than let the daemon assume `main`.
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
          source: req.body.source,
          ...(repoId !== undefined ? { githubRepoId: repoId } : {}),
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
            'Edit a source’s source string, ref, subdir, or skill filter. `skills` replaces the stored filter wholesale. Name is immutable (agents bind by name; recreate to rename). Changes re-push every agent that enables this source.',
          operationId: 'updateSkillSource',
          params: IdParam,
          body: UpdateSkillSourceBody,
          response: { 200: SkillSourceDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.skillSource.get(orgOf(req), req.params.id)
        if (!existing || !canView(existing, ctxOf(req))) return notFound(reply)
        // Same public-only guard as create, on the EFFECTIVE source — a PATCH that
        // points an existing source at a (now-confirmed) private repo is rejected too.
        if (await isPrivateRepo(orgOf(req), req.body.source ?? existing.source)) {
          return reply.code(400).send(privateNotSupported)
        }
        const repoId = parseRepoId(req.body.githubRepoId)
        // Preserve an explicit ref across an unrelated PATCH: only resolve a default
        // branch when the EFFECTIVE ref is absent (untouched-and-existing counts as
        // present), so a `skills`-only edit can't silently rewrite the pinned ref.
        const refTouched = req.body.ref !== undefined
        const currentRef = refTouched ? (req.body.ref ?? undefined) : (existing.ref ?? undefined)
        const effSubDir =
          req.body.subDir === undefined ? (existing.subDir ?? undefined) : (req.body.subDir ?? undefined)
        const resolvedRef = await resolveRefForSubdir(
          orgOf(req),
          req.body.source ?? existing.source,
          currentRef,
          effSubDir
        )
        // A subdir source needs a ref; reject if we couldn't resolve one rather than
        // let the daemon assume `main`.
        if (effSubDir && !resolvedRef) return reply.code(400).send(subdirNeedsRef)
        const source = await deps.repos.skillSource.update(orgOf(req), existing.id, {
          ...(req.body.source !== undefined ? { source: req.body.source } : {}),
          ...(repoId !== undefined ? { githubRepoId: repoId } : {}),
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
