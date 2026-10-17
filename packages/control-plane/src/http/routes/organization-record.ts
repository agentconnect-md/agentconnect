// The organization record's console routes (assistant-mode.md §5.16): its status, every entry's agent visibility, and People's cards.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isMemberIdentityKey } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonOwner, orgOf } from '../rbac.js'
import type { OrgId } from '../../domain/ids.js'
import { ownDirectoryKeys } from '../../agent-memory/members-directory.js'
import {
  isRecordKind,
  parsePeopleBlock,
  peopleEntries,
  peopleKeys,
  recordShapeRefusal,
  replacePeopleEntries
} from '../../organization-knowledge/record.js'
import type { OrganizationKnowledgeRecord } from '../../persistence/ports.js'
import {
  ErrorDto,
  IdParam,
  KnowledgeVisibilityDto,
  MyPeopleEntriesDto,
  OrganizationRecordDto,
  PeopleEntryBody,
  PeopleKeyParam,
  PeopleWriteDto,
  UpdateKnowledgeVisibilityBody
} from '../dto/index.js'
import { knowledgeDto } from './organization-knowledge.js'

const error = (reply: FastifyReply, statusCode: 400 | 403 | 404 | 409 | 503, message: string) =>
  reply.code(statusCode).send({
    error: { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 503: 'Service Unavailable' }[
      statusCode
    ],
    statusCode,
    message
  })

const STALE = 'People changed since it was loaded; refresh and try again'

/** The agent ids among `ids` that are agents of the organization, each once. */
async function organizationAgents(deps: HttpDeps, orgId: OrgId, ids: readonly string[]): Promise<string[]> {
  const known = new Set((await deps.repos.agent.list(orgId)).map((agent) => String(agent.id)))
  return [...new Set(ids)].filter((id) => known.has(id))
}

export function organizationRecordRoutes(deps: HttpDeps) {
  return async function organizationRecordRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const knowledge = deps.repos.organizationKnowledge
    const record = deps.repos.organizationRecord

    // A console user's keys among People's: their console account, and each linked chat identity among `keys`.
    const ownKeys = async (userId: string, keys: string[]): Promise<string[]> => {
      const identity = deps.logtoIdentity
      const sub = identity ? await deps.repos.user.getOidcSubject(userId) : null
      const links = identity && sub ? await identity.chatIdentitiesFor(sub).catch(() => []) : []
      return ownDirectoryKeys(userId, keys, links)
    }

    // People by its entry id, or an answer already sent.
    const people = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!knowledge || !record) {
        await error(reply, 503, 'the organization record is unavailable')
        return null
      }
      const row = await knowledge.getKnowledge(orgOf(req), req.params.id)
      if (!row || row.kind !== 'people') {
        await error(reply, 404, 'People not found')
        return null
      }
      return { row, record, optOut: new Set(await record.optOut(orgOf(req))) }
    }

    // Owner edits and clears of People are audited without content (§5.17).
    const audit = (req: FastifyRequest, operation: 'edit' | 'clear', row: OrganizationKnowledgeRecord, key: string) =>
      deps.repos.audit
        .append({
          kind: 'memory_change',
          orgId: orgOf(req),
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'knowledge/people',
          message: operation === 'clear' ? 'people entry cleared' : 'people entry edited',
          details: { operation, knowledgeId: row.id, key }
        })
        .catch((err: unknown) => req.log.warn({ err }, 'knowledge: audit append failed'))

    r.get(
      '/knowledge/organization',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Get the organization record',
          description:
            "The organization record's three entries (About, Channels and People), written by the organization's assistant-mode agents, and its research status: which agent researched the organization, when, and whether a round is running. Empty until an agent is switched into assistant mode.",
          operationId: 'getOrganizationRecord',
          response: { 200: OrganizationRecordDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!record) return error(reply, 503, 'the organization record is unavailable')
        const status = await record.status(orgOf(req))
        const owner = ctxOf(req).role === 'owner'
        return {
          research: {
            agentId: status.researchAgentId,
            researchedAt: status.researchedAt?.toISOString() ?? null,
            runningSince: status.runningSince?.toISOString() ?? null
          },
          entries: status.entries.map((row) => knowledgeDto(row, owner))
        }
      }
    )

    r.get(
      '/knowledge/:id/visibility',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Get which agents read a knowledge entry',
          description:
            'Returns `all` (every agent of the organization) or `selected` with the agent ids in `readers`. `canManage` is true for an owner on any entry but About and Channels, whose visibility is fixed.',
          operationId: 'getKnowledgeVisibility',
          params: IdParam,
          response: { 200: KnowledgeVisibilityDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!knowledge) return error(reply, 503, 'organization knowledge is unavailable')
        const row = await knowledge.getKnowledge(orgOf(req), req.params.id)
        if (!row) return error(reply, 404, 'knowledge entry not found')
        return {
          visibility: row.visibility,
          readers: row.readers,
          canManage: ctxOf(req).role === 'owner' && fixedVisibility(row) === undefined
        }
      }
    )

    r.put(
      '/knowledge/:id/visibility',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Set which agents read a knowledge entry',
          description:
            "Sets `all` or `selected` with the agents in `readers`, kept to the organization's agents; a `selected` list may be empty, and then no agent reads the entry. Organization owners only. About and Channels are read by every agent and refuse a change (409). On People this is a hand edit: switching an agent's assistant mode no longer changes the list.",
          operationId: 'updateKnowledgeVisibility',
          params: IdParam,
          body: UpdateKnowledgeVisibilityBody,
          response: { 200: KnowledgeVisibilityDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!knowledge) return error(reply, 503, 'organization knowledge is unavailable')
        const orgId = orgOf(req)
        const row = await knowledge.getKnowledge(orgId, req.params.id)
        if (!row) return error(reply, 404, 'knowledge entry not found')
        const fixed = fixedVisibility(row)
        if (fixed) return error(reply, 409, fixed)
        const readers =
          req.body.visibility === 'selected' ? await organizationAgents(deps, orgId, req.body.readers) : []
        const updated = await knowledge.setKnowledgeVisibility(orgId, row.id, {
          visibility: req.body.visibility,
          readers
        })
        if (!updated) return error(reply, 404, 'knowledge entry not found')
        return { visibility: updated.visibility, readers: updated.readers, canManage: true }
      }
    )

    r.get(
      '/knowledge/:id/people/mine',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Read your People entry',
          description:
            "The signed-in caller's own entries in People: the one keyed by their console account and any keyed by a chat identity they linked. Nobody else's entry is returned. `keys` are the keys they may write their entry under.",
          operationId: 'readMyPeopleEntry',
          params: IdParam,
          response: { 200: MyPeopleEntriesDto, 401: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal?.userId
        if (!userId) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'sign in first' })
        const got = await people(req, reply)
        if (!got) return
        const own = new Set(await ownKeys(userId, peopleKeys(got.row.content)))
        return { revision: got.row.currentRevision, entries: peopleEntries(got.row.content, own), keys: [...own] }
      }
    )

    r.put(
      '/knowledge/:id/people/mine',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Write your People entry',
          description:
            "Replace the signed-in caller's own entry in People with one entry keyed by their console account or a chat identity they linked, checked against People's shape; 400 names the line that failed. Writing it lifts an earlier removal. 409 when People changed since `expectedRevision`.",
          operationId: 'writeMyPeopleEntry',
          params: IdParam,
          body: PeopleEntryBody,
          response: { 200: PeopleWriteDto, 400: ErrorDto, 401: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal?.userId
        if (!userId) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'sign in first' })
        const got = await people(req, reply)
        if (!got) return
        const block = parsePeopleBlock(req.body.text)
        if ('refusal' in block) return error(reply, 400, block.refusal)
        const own = await ownKeys(userId, [...peopleKeys(got.row.content), block.key])
        if (!own.includes(block.key)) return error(reply, 403, 'you can write only your own entry')
        // Their own entry under one key: any other of their keys' entries goes.
        const text = replacePeopleEntries(got.row.content, own, { key: block.key, text: req.body.text })
        const refusal = recordShapeRefusal('people', text)
        if (refusal) return error(reply, 400, refusal)
        const written = await got.record.write(orgOf(req), 'people', {
          baseRevision: req.body.expectedRevision,
          content: text,
          provenance: { source: 'manual', createdByUserId: userId },
          optOut: { mark: [], lift: own.filter((key) => got.optOut.has(key)) },
          now: new Date()
        })
        if (written.outcome !== 'written') return error(reply, 409, STALE)
        return { revision: written.entry.currentRevision }
      }
    )

    r.delete(
      '/knowledge/:id/people/mine',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Remove your People entry',
          description:
            "Remove the signed-in caller's own entries from People and keep them out of it: nothing is written about them again until they write their entry themselves. The answer says whether there was an entry and never carries its content.",
          operationId: 'removeMyPeopleEntry',
          params: IdParam,
          response: { 200: PeopleWriteDto, 401: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal?.userId
        if (!userId) return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'sign in first' })
        const got = await people(req, reply)
        if (!got) return
        const own = await ownKeys(userId, peopleKeys(got.row.content))
        const text = replacePeopleEntries(got.row.content, own)
        const cleared = peopleKeys(got.row.content).some((key) => own.includes(key))
        const written = await got.record.write(orgOf(req), 'people', {
          baseRevision: got.row.currentRevision,
          content: cleared ? text : got.row.content,
          provenance: { source: 'manual', createdByUserId: userId },
          optOut: { mark: own, lift: [] },
          now: new Date()
        })
        if (written.outcome !== 'written') return error(reply, 409, STALE)
        return { revision: written.entry.currentRevision, cleared }
      }
    )

    r.put(
      '/knowledge/:id/people/:key',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: "Edit a person's People entry",
          description:
            "Replace one person's entry in People, checked against People's shape; 400 names the line that failed. Organization owners only (403 otherwise). A person who removed their entry stays out until they write it themselves (409). Recorded in the organization's audit log without content.",
          operationId: 'updatePeopleEntry',
          params: PeopleKeyParam,
          body: PeopleEntryBody,
          response: { 200: PeopleWriteDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const got = await people(req, reply)
        if (!got) return
        const { key } = req.params
        const block = parsePeopleBlock(req.body.text)
        if ('refusal' in block) return error(reply, 400, block.refusal)
        if (block.key !== key) return error(reply, 400, `the entry's heading must end in \`${key}\``)
        if (got.optOut.has(key))
          return error(reply, 409, 'this person removed their entry; only they can write it again')
        const text = replacePeopleEntries(got.row.content, [], { key, text: req.body.text })
        const refusal = recordShapeRefusal('people', text)
        if (refusal) return error(reply, 400, refusal)
        const written = await got.record.write(orgOf(req), 'people', {
          baseRevision: req.body.expectedRevision,
          content: text,
          provenance: { source: 'manual', ...(req.principal ? { createdByUserId: req.principal.userId } : {}) },
          optOut: { mark: [], lift: [] },
          now: new Date()
        })
        if (written.outcome !== 'written') return error(reply, 409, STALE)
        await audit(req, 'edit', got.row, key)
        return { revision: written.entry.currentRevision }
      }
    )

    r.delete(
      '/knowledge/:id/people/:key',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: "Clear a person's People entry",
          description:
            "Remove one person's entry from People and keep them out of it, as their own removal does; for a console account's key, the entries keyed by the chat identities it linked go too. Organization owners only (403 otherwise). The answer never carries the content; the clear is recorded in the organization's audit log without it.",
          operationId: 'clearPeopleEntry',
          params: PeopleKeyParam,
          response: { 200: PeopleWriteDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const got = await people(req, reply)
        if (!got) return
        const { key } = req.params
        if (!isMemberIdentityKey(key)) return error(reply, 400, 'not a People key')
        const keys = key.startsWith('user:') ? await ownKeys(key.slice(5), peopleKeys(got.row.content)) : [key]
        const cleared = peopleKeys(got.row.content).some((k) => keys.includes(k))
        const written = await got.record.write(orgOf(req), 'people', {
          baseRevision: got.row.currentRevision,
          content: cleared ? replacePeopleEntries(got.row.content, keys) : got.row.content,
          provenance: { source: 'manual', ...(req.principal ? { createdByUserId: req.principal.userId } : {}) },
          optOut: { mark: keys, lift: [] },
          now: new Date()
        })
        if (written.outcome !== 'written') return error(reply, 409, STALE)
        await audit(req, 'clear', got.row, key)
        return { revision: written.entry.currentRevision, cleared }
      }
    )
  }
}

/** Why an entry's visibility cannot change: About and Channels are every agent's (§5.16). */
export function fixedVisibility(row: OrganizationKnowledgeRecord): string | undefined {
  return isRecordKind(row.kind) && row.kind !== 'people'
    ? 'About and Channels are read by every agent; their visibility does not change'
    : undefined
}
