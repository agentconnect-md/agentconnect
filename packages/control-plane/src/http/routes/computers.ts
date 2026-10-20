// Computers (computer-use.md §2.2, §3.6, §4.1): the org-scoped console surface and the public registration exchange.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ComputerAuditRecord, ComputerRecord } from '../../persistence/ports.js'
import { ComputerId } from '../../domain/ids.js'
import { ComputerPolicySchema, withOwnerMember } from '../../domain/computer.js'
import { orgOf, ctxOf, denyViewerWrite } from '../rbac.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { publicBaseUrl } from '../oauth/base.js'
import { COMPUTER_WS_PUBLIC_PATH } from '@agentconnect.md/protocol'
import {
  ComputerAuditPageDto,
  ComputerAuditQuery,
  ComputerDto,
  ComputerListDto,
  ComputerRegistrationDto,
  CreateComputerRegistrationBody,
  RegisterComputerBody,
  RegisteredComputerDto,
  SetSharingBody,
  IdParam,
  ErrorDto,
  type ComputerDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

/** The registration exchange's path under the versioned API; the public form is `/v1` + this. */
export const COMPUTER_REGISTER_PATH = '/computers/register'

const notFound = { error: 'Not Found', statusCode: 404, message: 'computer not found' }
const revokedConflict = { error: 'Conflict', statusCode: 409, message: 'computer is revoked' }

/** Who may change who uses a Computer: the registrant of their own desktop, any editor of a managed one. */
function canEditPolicy(c: ComputerRecord, ctx: ViewCtx): boolean {
  if (!canEdit(c, ctx)) return false
  return c.kind !== 'self-hosted' || c.ownerUserId === ctx.userId
}

// An audit page cursor: the last entry's time and id, opaque to callers.
const encodeCursor = (e: ComputerAuditRecord): string =>
  Buffer.from(`${e.at.toISOString()}|${e.id}`).toString('base64url')

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|')
  const date = new Date(at ?? '')
  return id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(date.getTime()) ? { at: date, id } : null
}

const auditDto = (e: ComputerAuditRecord) => ({
  id: e.id,
  at: e.at.toISOString(),
  tool: e.tool,
  client: e.client,
  agentId: e.agentId,
  sessionId: e.sessionId,
  outcome: e.outcome,
  code: e.code,
  approval: e.approval,
  args: e.args,
  textLength: e.textLength,
  ms: e.ms,
  screenshotRef: e.screenshotRef
})

function toDto(c: ComputerRecord, ctx: ViewCtx, status: ComputerRecord['status']): ComputerDtoT {
  return {
    id: c.id,
    name: c.name,
    ownerUserId: c.ownerUserId,
    kind: c.kind,
    isolation: c.isolation,
    os: c.os,
    osVersion: c.osVersion,
    session: c.session,
    status,
    capabilities: c.capabilities,
    doctor: c.doctor,
    desktopDaemonVersion: c.desktopDaemonVersion,
    driverVersion: c.driverVersion,
    policy: c.policy,
    visibility: c.visibility,
    sharedWith: c.sharedWith,
    lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    canEdit: canEdit(c, ctx),
    canEditPolicy: canEditPolicy(c, ctx) && c.status !== 'revoked'
  }
}

export function computerRoutes(deps: HttpDeps) {
  return async function computerRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // The repository fences the org; visibility is the policy half, and an invisible Computer reads as absent.
    const getOrgComputer = async (req: FastifyRequest, id: string) => {
      const c = await deps.repos.computer.get(orgOf(req), ComputerId(id))
      return c && canView(c, ctxOf(req)) ? c : null
    }

    r.get(
      '/computers',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'List computers',
          description: 'Lists the organization’s registered Computers the caller can see.',
          operationId: 'listComputers',
          response: { 200: ComputerListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.computer.list(orgOf(req), ctxOf(req))
        return rows.map((c) => toDto(c, ctxOf(req), deps.computers.presentedStatus(c)))
      }
    )

    r.get(
      '/computers/:id',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get a computer',
          description: 'Reads one Computer: its platform, reported capabilities, status, sharing and usage policy.',
          operationId: 'getComputer',
          params: IdParam,
          response: { 200: ComputerDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        return toDto(c, ctxOf(req), deps.computers.presentedStatus(c))
      }
    )

    // The audit shows what agents did on someone's desktop, so it is the owner's, as the policy is.
    r.get(
      '/computers/:id/audit',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'List computer audit entries',
          description:
            'Lists the calls a Computer’s desktop daemon served, newest first: the agent and session, the tool, its outcome, how it was approved, and its arguments with typed text recorded only as `textLength`. Only the registrant of a self-hosted Computer, or an editor of a managed one, may read it. Pass a page’s `nextCursor` back as `cursor` for older entries; filter by `agentId` or `sessionId`. Entries are kept for 90 days.',
          operationId: 'listComputerAudit',
          params: IdParam,
          querystring: ComputerAuditQuery,
          response: { 200: ComputerAuditPageDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEditPolicy(c, ctxOf(req))) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'only the computer’s owner can read its audit' })
        }
        const before = req.query.cursor ? decodeCursor(req.query.cursor) : undefined
        if (before === null) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'invalid cursor' })
        }
        const limit = req.query.limit
        const rows = await deps.computerAudit.list(orgOf(req), c.id, {
          limit: limit + 1,
          ...(before ? { before } : {}),
          ...(req.query.agentId ? { agentId: req.query.agentId } : {}),
          ...(req.query.sessionId ? { sessionId: req.query.sessionId } : {})
        })
        const page = rows.slice(0, limit)
        return {
          entries: page.map(auditDto),
          nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null
        }
      }
    )

    // A registration token is a credential: only an interactive sign-in may mint one.
    r.post(
      '/computers/registrations',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Create a computer registration',
          description:
            'Mints a short-lived, one-time registration token the desktop daemon exchanges for its Computer key. The caller becomes the Computer’s owner.',
          operationId: 'createComputerRegistration',
          body: CreateComputerRegistrationBody,
          response: { 201: ComputerRegistrationDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const issued = await deps.computers.createRegistration({
          orgId: orgOf(req),
          createdByUserId: ctxOf(req).userId,
          ...(req.body.name ? { name: req.body.name } : {}),
          ...(req.body.ttlMinutes !== undefined ? { ttlMinutes: req.body.ttlMinutes } : {})
        })
        return reply.code(201).send({
          registrationId: issued.registration.id,
          token: issued.token,
          displayTail: issued.registration.displayTail,
          name: issued.registration.name,
          expiresAt: issued.registration.expiresAt.toISOString(),
          exchangeUrl: `${publicBaseUrl(req, deps.config)}/v1${COMPUTER_REGISTER_PATH}`
        })
      }
    )

    r.put(
      '/computers/:id/policy',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set computer policy',
          description:
            'Replaces who may use a Computer and how (allowed agents and members, view or control, approvals, app limits, quiet hours, lease limits). Omitted fields take their defaults. Only the registrant may change the policy of their own self-hosted desktop; allowed agents must be visible to the caller, and the owner always stays an allowed member.',
          operationId: 'setComputerPolicy',
          params: IdParam,
          body: ComputerPolicySchema,
          response: { 200: ComputerDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEditPolicy(c, ctxOf(req))) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'only the computer’s owner can change its policy' })
        }
        if (c.status === 'revoked') return reply.code(409).send(revokedConflict)
        // A referenced agent must be one the caller can see; an unknown or invisible one is refused alike.
        const wanted = [...new Set(req.body.allowedAgents)]
        if (wanted.length > 0) {
          const visible = new Set((await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => a.id as string))
          const unknown = wanted.filter((id) => !visible.has(id))
          if (unknown.length > 0) {
            return reply
              .code(400)
              .send({ error: 'Bad Request', statusCode: 400, message: `unknown agent: ${unknown.join(', ')}` })
          }
        }
        const members = await resolveShareSet(deps.repos.user, orgOf(req), req.body.allowedMembers)
        const policy = withOwnerMember({ ...req.body, allowedAgents: wanted, allowedMembers: members }, c.ownerUserId)
        const updated = await deps.computers.setPolicy(orgOf(req), c.id, policy, ctxOf(req).userId)
        if (!updated) return reply.code(409).send(revokedConflict)
        return toDto(updated, ctxOf(req), deps.computers.presentedStatus(updated))
      }
    )

    r.put(
      '/computers/:id/sharing',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set computer sharing',
          description:
            'Sets who can see a Computer in the console (Everyone vs Selected). Requires edit rights; Selected must retain at least one current organization member, and a self-hosted desktop’s registrant always stays in it. Sharing grants no agent access: the policy decides that.',
          operationId: 'setComputerSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canManageSharing(c, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        const updated = await deps.repos.computer.setSharing(
          orgOf(req),
          c.id,
          { visibility: req.body.visibility, sharedWith },
          ctxOf(req).userId
        )
        return toDto(updated, ctxOf(req), deps.computers.presentedStatus(updated))
      }
    )

    // Revocation kills the Computer's credentials, so like every key revocation it takes an interactive sign-in.
    r.post(
      '/computers/:id/revoke',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Revoke a computer',
          description:
            'Marks a Computer revoked and revokes every key it holds, so its desktop daemon can no longer authenticate. Idempotent.',
          operationId: 'revokeComputer',
          params: IdParam,
          response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEdit(c, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this computer' })
        }
        const revoked = await deps.computers.revoke(orgOf(req), c.id, ctxOf(req).userId)
        return toDto(revoked, ctxOf(req), deps.computers.presentedStatus(revoked))
      }
    )

    // Deleting cascades the Computer's keys, so it takes an interactive sign-in like revocation.
    r.delete(
      '/computers/:id',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Delete a computer',
          description: 'Removes a Computer and, by cascade, every key it holds.',
          operationId: 'deleteComputer',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEdit(c, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this computer' })
        }
        await deps.computers.delete(orgOf(req), c.id, ctxOf(req).userId)
        return reply.code(204).send(null)
      }
    )
  }
}

/** The unauthenticated exchange: the registration token in the body is the credential. */
export function computerRegisterRoutes(deps: HttpDeps, opts: { hide?: boolean } = {}) {
  return async function computerRegisterRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.post(
      COMPUTER_REGISTER_PATH,
      {
        schema: {
          ...(opts.hide ? { hide: true } : {}),
          tags: [Tag.Computers],
          summary: 'Register a computer',
          description:
            'Called by the desktop daemon: exchanges a one-time registration token for an API key bound to one new Computer in the token’s organization, and names the Computer channel URL to dial with it. The key authenticates only the Computer channel. An unknown, spent or expired token is refused with 401.',
          operationId: 'registerComputer',
          security: [],
          body: RegisterComputerBody,
          response: { 201: RegisteredComputerDto, 401: ErrorDto }
        }
      },
      async (req, reply) => {
        const { token, ...profile } = req.body
        const registered = await deps.computers.register(token, { ...profile, kind: 'self-hosted' })
        if (!registered) {
          return reply
            .code(401)
            .send({ error: 'Unauthorized', statusCode: 401, message: 'invalid or expired registration token' })
        }
        return reply.code(201).send({
          computerId: registered.computer.id,
          orgId: registered.computer.orgId,
          apiKeyId: registered.apiKeyId,
          apiKey: registered.apiKey,
          displayTail: registered.displayTail,
          channelUrl: `${publicBaseUrl(req, deps.config).replace(/^http/, 'ws')}${COMPUTER_WS_PUBLIC_PATH}`
        })
      }
    )
  }
}
