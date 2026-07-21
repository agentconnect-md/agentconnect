/**
 * `http/routes/skill-sources.ts` (design docs/designs/shared-skills.md §4).
 *
 * CRUD for org-level shared-skills sources. A source records only WHERE skills
 * come from (a repo / git URL / tree path) plus an optional ref + skill filter —
 * skill CONTENT never touches the CP. The daemon installs enabled skills via
 * `npx skills` after clone and before the ACP host spawns.
 *
 * There is NO secret side-table and NO grant (unlike MCP providers): skills carry
 * no upstream credential, and private-repo reads reuse the daemon's GitHub App
 * token path. The source definition is not pushed on its own frame either — it
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
import { canView, canManageSharing, type ViewCtx } from '../visibility.js'
import { resolveShareSet } from '../sharing.js'
import { parseSkillRef } from '../../orchestrator/skillSource.js'
import {
  CreateSkillSourceBody,
  UpdateSkillSourceBody,
  PreviewSkillSourceBody,
  SkillSourcePreviewDto,
  SkillSourceDto,
  SkillSourceListDto,
  SetSharingBody,
  ErrorDto,
  IdParam,
  type SkillSourceDtoT
} from '../dto/index.js'

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
        const s = await deps.repos.skillSource.get(req.params.id)
        if (!s || s.orgId !== orgOf(req) || !canView(s, ctxOf(req))) return notFound(reply)
        return toDto(s, ctxOf(req))
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
            'Register an org-level shared-skills source (a repo / git URL / tree path fed to `npx skills`). `skills` empty ⇒ install every skill the source exposes.',
          operationId: 'createSkillSource',
          body: CreateSkillSourceBody,
          response: { 201: SkillSourceDto, 400: ErrorDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const sharedWith =
          req.body.visibility === 'restricted' && req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
            : undefined
        const repoId = parseRepoId(req.body.githubRepoId)
        const source = await deps.repos.skillSource.create({
          orgId: orgOf(req),
          name: req.body.name,
          source: req.body.source,
          ...(repoId !== undefined ? { githubRepoId: repoId } : {}),
          ...(req.body.ref !== undefined ? { ref: req.body.ref } : {}),
          ...(req.body.subDir !== undefined ? { subDir: req.body.subDir } : {}),
          skills: req.body.skills,
          ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
          ...(sharedWith ? { sharedWith } : {}),
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
        return reply.code(201).send(toDto(source, ctxOf(req)))
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
        const existing = await deps.repos.skillSource.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) return notFound(reply)
        const repoId = parseRepoId(req.body.githubRepoId)
        const source = await deps.repos.skillSource.update(existing.id, {
          ...(req.body.source !== undefined ? { source: req.body.source } : {}),
          ...(repoId !== undefined ? { githubRepoId: repoId } : {}),
          ...(req.body.ref !== undefined ? { ref: req.body.ref } : {}),
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
            'Set the source’s visibility (org-wide vs restricted) and share set. Requires edit rights; sharedWith is intersected with current org members.',
          operationId: 'setSkillSourceSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: SkillSourceDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.skillSource.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) return notFound(reply)
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        const source = await deps.repos.skillSource.setSharing(existing.id, {
          visibility: req.body.visibility,
          sharedWith
        })
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
        const existing = await deps.repos.skillSource.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) return notFound(reply)
        const agents = await deps.repos.agent.list(orgOf(req))
        const referenced = agents.some((a) => a.skills.some((ref) => parseSkillRef(ref).source === existing.name))
        if (referenced) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'skill source is still enabled by one or more agents; unselect it there first'
          })
        }
        await deps.repos.skillSource.delete(existing.id)
        return reply.code(204).send(null)
      }
    )
  }
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'skill source not found' })
}
