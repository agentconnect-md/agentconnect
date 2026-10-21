// Computers (computer-use.md §2.2, §3.6, §4.1): the org-scoped console surface and the public registration exchange.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ComputerAuditRecord, ComputerRecord } from '../../persistence/ports.js'
import { ComputerId } from '../../domain/ids.js'
import { poolActions } from '../../domain/computerPool.js'
import type { LeaseOccupancy } from '../../domain/computerLease.js'
import {
  ComputerPolicySchema,
  agentAccessIsFixed,
  TooManyComputerAgents,
  withOwnerMember,
  type ComputerAgentAccess,
  type ComputerPolicy
} from '../../domain/computer.js'
import { orgOf, ctxOf, denyViewerWrite } from '../rbac.js'
import {
  AuthorizationAction,
  can,
  canView,
  canEdit,
  canManageSharing,
  type ViewCtx
} from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { publicBaseUrl } from '../oauth/base.js'
import { desktopImage } from '../../package-version.js'
import { COMPUTER_WS_PUBLIC_PATH } from '@agentconnect.md/protocol'
import {
  ComputerAuditPageDto,
  ComputerAuditQuery,
  ComputerDto,
  ComputerListDto,
  ComputerRegistrationDto,
  ComputerRegistrationStatusDto,
  ComputerViewerGrantDto,
  CreateComputerRegistrationBody,
  CreatePoolComputerBody,
  ComputerPoolStatusDto,
  RegisterComputerBody,
  RegisteredComputerDto,
  SetComputerAgentAccessBody,
  ComputerAgentParams,
  SetSharingBody,
  IdParam,
  ErrorDto,
  type ComputerDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { DESKTOP_BUNDLE_FILE, DESKTOP_LEGAL_FILE } from '../../computer-install/desktop-distribution.js'

/** The registration exchange's path under the versioned API; the public form is `/v1` + this. */
export const COMPUTER_REGISTER_PATH = '/computers/register'
/** The Linux one-line installer (computer-use.md §3.5); the public form is `/v1` + this. */
export const COMPUTER_LINUX_INSTALLER_PATH = '/computers/install.sh'
/** The files the installer downloads, under the bundle's sha256; only these names are served. */
export const COMPUTER_DESKTOP_FILES_PATH = '/computers/desktop'

const notFound = { error: 'Not Found', statusCode: 404, message: 'computer not found' }
const revokedConflict = { error: 'Conflict', statusCode: 409, message: 'computer is revoked' }

/** Who may change who uses a Computer: the registrant of their own desktop, any editor of a managed one. */
function canEditPolicy(c: ComputerRecord, ctx: ViewCtx): boolean {
  if (!canEdit(c, ctx)) return false
  return c.kind !== 'self-hosted' || c.ownerUserId === ctx.userId
}

/** Who may change which agents use a Computer (§4.1): its policy editors; a per-agent or ephemeral one follows its agent. */
function canEditAgentAccess(c: ComputerRecord, ctx: ViewCtx): boolean {
  return canEditPolicy(c, ctx) && c.status !== 'revoked' && !agentAccessIsFixed(c)
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

const occupancyDto = (occ: LeaseOccupancy | undefined) => ({
  lease: occ?.holder
    ? {
        sessionId: occ.holder.sessionId,
        agentId: occ.holder.agentId,
        agentName: occ.holder.agentName,
        acquiredAt: new Date(occ.holder.acquiredAt).toISOString()
      }
    : null,
  waiting: (occ?.waiting ?? []).map((w) => ({
    sessionId: w.sessionId,
    agentId: w.agentId,
    since: new Date(w.enqueuedAt).toISOString()
  }))
})

function toDto(
  c: ComputerRecord,
  ctx: ViewCtx,
  status: ComputerRecord['status'],
  retentionDays: (policy: ComputerRecord['policy']) => number,
  occ?: LeaseOccupancy
): ComputerDtoT {
  const actions = poolActions({
    allocation: c.allocation,
    poolPhase: c.poolPhase,
    poolError: c.poolError,
    revoked: c.revokedAt !== null || c.status === 'revoked'
  })
  const editable = canEdit(c, ctx)
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
    stoppedAt: c.stoppedAt ? c.stoppedAt.toISOString() : null,
    stoppedByUserId: c.stoppedByUserId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    screenshotRetentionDays: retentionDays(c.policy),
    canEdit: canEdit(c, ctx),
    canEditPolicy: canEditPolicy(c, ctx) && c.status !== 'revoked',
    agentAccess: c.agentAccess,
    canEditAgentAccess: canEditAgentAccess(c, ctx),
    allocation: c.allocation,
    ownerAgentId: c.ownerAgentId,
    poolPhase: c.poolPhase,
    poolError: c.poolError,
    poolActions: {
      wake: editable && actions.wake,
      sleep: editable && actions.sleep,
      reset: editable && actions.reset
    },
    ...occupancyDto(occ)
  }
}

const fixedAccess = {
  error: 'Conflict',
  statusCode: 409,
  message: 'a per-agent or ephemeral computer is used only by the agent it was made for'
}
const cannotChangeAccess = { error: 'Forbidden', statusCode: 403, message: 'cannot change who uses this computer' }
const allAgents = {
  error: 'Conflict',
  statusCode: 409,
  message: 'this computer is granted to all agents; change its agent access on the computer'
}
const unknownAgents = (ids: string[]) => ({
  error: 'Bad Request',
  statusCode: 400,
  message: `unknown agent: ${ids.join(', ')}`
})

export function computerRoutes(deps: HttpDeps) {
  return async function computerRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // Without a bucket nothing is stored, whatever the policy says.
    const retentionDays = (policy: ComputerRecord['policy']): number =>
      deps.computerScreenshots?.retentionDays(policy) ?? 0

    // Who holds each lease and who waits (§4.4); a display read, so a failure leaves the fields empty.
    const occupancy = async (rows: ComputerRecord[]) =>
      deps.computerLeases && rows.length > 0
        ? await deps.computerLeases.occupancy(rows).catch(() => new Map<string, LeaseOccupancy>())
        : new Map<string, LeaseOccupancy>()
    const presentAll = async (req: FastifyRequest, rows: ComputerRecord[]): Promise<ComputerDtoT[]> => {
      const occ = await occupancy(rows)
      return rows.map((c) => toDto(c, ctxOf(req), deps.computers.presentedStatus(c), retentionDays, occ.get(c.id)))
    }
    const present = async (req: FastifyRequest, c: ComputerRecord): Promise<ComputerDtoT> =>
      (await presentAll(req, [c]))[0]!

    // The repository fences the org; visibility is the policy half, and an invisible Computer reads as absent.
    const getOrgComputer = async (req: FastifyRequest, id: string) => {
      const c = await deps.repos.computer.get(orgOf(req), ComputerId(id))
      return c && canView(c, ctxOf(req)) ? c : null
    }

    const visibleAgentIds = async (req: FastifyRequest): Promise<Set<string>> =>
      new Set((await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => a.id as string))

    // An agent newly given access must be one the caller can see; an unknown or invisible one is refused alike.
    const invisibleAgents = async (req: FastifyRequest, ids: readonly string[]): Promise<string[]> => {
      if (ids.length === 0) return []
      const visible = await visibleAgentIds(req)
      return ids.filter((id) => !visible.has(id))
    }

    // The checks every agent access write shares: the Computer, or the refusal to send.
    const accessTarget = async (
      req: FastifyRequest,
      id: string
    ): Promise<{ computer: ComputerRecord } | { status: 403 | 404 | 409; body: typeof notFound }> => {
      const c = await getOrgComputer(req, id)
      if (!c) return { status: 404, body: notFound }
      if (agentAccessIsFixed(c)) return { status: 409, body: fixedAccess }
      if (!canEditPolicy(c, ctxOf(req))) return { status: 403, body: cannotChangeAccess }
      if (c.status === 'revoked') return { status: 409, body: revokedConflict }
      return { computer: c }
    }

    const accessReply = async (req: FastifyRequest, reply: FastifyReply, updated: ComputerRecord | null) =>
      updated ? await present(req, updated) : reply.code(409).send(revokedConflict)

    // An access write, or the 409 for a Selected list past the cap.
    const writeAccess = async (
      reply: FastifyReply,
      write: () => Promise<ComputerRecord | null>
    ): Promise<{ updated: ComputerRecord | null } | { sent: FastifyReply }> => {
      try {
        return { updated: await write() }
      } catch (err) {
        if (!(err instanceof TooManyComputerAgents)) throw err
        return { sent: reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message }) }
      }
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
        return await presentAll(req, rows)
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
        return await present(req, c)
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
          exchangeUrl: `${publicBaseUrl(req, deps.config)}/v1${COMPUTER_REGISTER_PATH}`,
          linuxInstallerUrl: deps.desktopDistribution
            ? `${publicBaseUrl(req, deps.config)}/v1${COMPUTER_LINUX_INSTALLER_PATH}`
            : null,
          desktopImage: desktopImage(deps.config.COMPUTER_DESKTOP_IMAGE)
        })
      }
    )

    // Only the member who minted a token learns whether it was spent; anyone else reads it as absent.
    r.get(
      '/computers/registrations/:id',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get a computer registration',
          description:
            'Reads whether a registration token the caller minted has been spent and, once it has, the Computer it registered. Never returns the token.',
          operationId: 'getComputerRegistration',
          params: IdParam,
          response: { 200: ComputerRegistrationStatusDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const reg = await deps.repos.computer.getRegistration(orgOf(req), req.params.id)
        if (!reg || reg.createdByUserId !== ctxOf(req).userId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'registration not found' })
        }
        return {
          registrationId: reg.id,
          expiresAt: reg.expiresAt.toISOString(),
          consumedAt: reg.consumedAt ? reg.consumedAt.toISOString() : null,
          computerId: reg.computerId
        }
      }
    )

    // A user's `manual` computer from the Kubernetes pool (§15.1): it is started now and sleeps when idle.
    r.post(
      '/computers/pool',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Create a pool computer',
          description:
            'Creates a `manual` managed computer in the deployment’s Kubernetes pool: a Linux desktop pod with its own volume, which registers itself and appears with `kind: managed`. It is assigned to agents through its `agentAccess` (here or with `PUT /computers/{id}/agent-access`), none by default; agents with access share it one at a time under the control lease. It sleeps when idle, keeping its volume, wakes on the next use, and stays until it is deleted. The caller becomes its owner. 503 when the deployment runs no pool or no pool member is connected.',
          operationId: 'createPoolComputer',
          body: CreatePoolComputerBody,
          response: { 201: ComputerDto, 400: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const unavailable = {
          error: 'Service Unavailable',
          statusCode: 503,
          message: 'this deployment cannot start managed computers now'
        }
        if (!deps.computerPool) return reply.code(503).send(unavailable)
        const ctx = ctxOf(req)
        let policy: ComputerPolicy | undefined
        if (req.body.policy) {
          const members = await resolveShareSet(deps.repos.user, orgOf(req), req.body.policy.allowedMembers)
          policy = withOwnerMember({ ...req.body.policy, allowedMembers: members }, ctx.userId)
        }
        const agentAccess: ComputerAgentAccess | undefined = req.body.agentAccess
        const unknown = await invisibleAgents(req, agentAccess?.mode === 'selected' ? agentAccess.agents : [])
        if (unknown.length > 0) return reply.code(400).send(unknownAgents(unknown))
        const created = await deps.computerPool.createManual(orgOf(req), {
          name: req.body.name,
          ownerUserId: ctx.userId,
          ...(policy ? { policy } : {}),
          ...(agentAccess ? { agentAccess } : {})
        })
        if (!created) return reply.code(503).send(unavailable)
        return reply.code(201).send(await present(req, created))
      }
    )

    r.get(
      '/computers/pool',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get the computer pool status',
          description:
            'Says whether this deployment runs managed computers in its Kubernetes pool (`enabled`) and whether a pool member that can start, wake or sleep one is connected now (`available`). The console offers pool computers and an agent’s managed mode from it.',
          operationId: 'getComputerPool',
          response: { 200: ComputerPoolStatusDto }
        }
      },
      async () => ({ enabled: deps.computerPool !== undefined, available: deps.computerPool?.available() ?? false })
    )

    // Wake, sleep and reset (§10, §15.1): any editor of a `per-agent` or `manual` computer, where its phase allows.
    const poolCommand = (
      path: 'wake' | 'sleep' | 'reset',
      summary: string,
      description: string,
      operationId: string,
      run: NonNullable<HttpDeps['computerPool']>['wakeNow']
    ) =>
      r.post(
        `/computers/:id/${path}`,
        {
          schema: {
            tags: [Tag.Computers],
            summary,
            description,
            operationId,
            params: IdParam,
            response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
          }
        },
        async (req, reply) => {
          if (denyViewerWrite(req, reply)) return
          const c = await getOrgComputer(req, req.params.id)
          if (!c) return reply.code(404).send(notFound)
          if (!canEdit(c, ctxOf(req))) {
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this computer' })
          }
          if (!deps.computerPool || c.kind !== 'managed' || !c.poolPhase) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'only a managed computer from the pool can do this'
            })
          }
          const result = await run(orgOf(req), c.id)
          if (result.ok) return await present(req, result.computer)
          if (result.code === 'not_found') return reply.code(404).send(notFound)
          const status = result.code === 'no_pool' ? 503 : 409
          return reply.code(status).send({
            error: status === 503 ? 'Service Unavailable' : 'Conflict',
            statusCode: status,
            message: result.message
          })
        }
      )
    poolCommand(
      'wake',
      'Wake a pool computer',
      'Starts a sleeping (or failed) `per-agent` or `manual` managed computer again from its kept volume, with its files, browser profile and sign-ins. Returns at once; the computer is `waking` until it is back online. 409 for an ephemeral or self-hosted computer, or one whose volume is gone or whose reset did not finish (reset it instead); 503 without a pool member.',
      'wakeComputer',
      (orgId, id) => deps.computerPool!.wakeNow(orgId, id)
    )
    poolCommand(
      'sleep',
      'Put a pool computer to sleep',
      'Stops the pod of an awake `per-agent` or `manual` managed computer and keeps its volume; the next use, or Wake, starts it again. 409 while a session holds its control lease or starts using it meanwhile, or for an ephemeral or self-hosted computer; 503 without a pool member.',
      'sleepComputer',
      (orgId, id) => deps.computerPool!.sleepNow(orgId, id)
    )
    poolCommand(
      'reset',
      'Reset a pool computer',
      'Deletes the pod and the volume of a `per-agent` or `manual` managed computer and provisions it again, empty: its files, browser profile and sign-ins are lost, while its name, agent access and policy stay. Any control lease ends. 409 for an ephemeral or self-hosted computer; 503 without a pool member.',
      'resetComputer',
      (orgId, id) => deps.computerPool!.resetNow(orgId, id)
    )

    // Stop only tightens, so anyone who may revoke the Computer may stop it; resuming is the policy owner's.
    r.post(
      '/computers/:id/stop',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Stop a computer',
          description:
            'The console Stop: ends any control lease, refuses agent input, and holds the desktop daemon paused until the Computer is resumed. Screenshots continue. Idempotent; a revoked Computer is refused with 409.',
          operationId: 'stopComputer',
          params: IdParam,
          response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEdit(c, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this computer' })
        }
        if (c.stoppedAt) return await present(req, c)
        const stopped = await deps.computers.stop(orgOf(req), c.id, ctxOf(req).userId)
        if (!stopped) return reply.code(409).send(revokedConflict)
        return await present(req, stopped)
      }
    )

    // Watching someone's desktop is the policy's allowed members' right; minting the credential takes an interactive sign-in.
    r.post(
      '/computers/:id/viewer',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Open a computer viewer',
          description:
            'Mints a short-lived viewer token for the console’s embedded viewer, the relays to reach the desktop through, the relays’ STUN addresses when the Computer’s policy allows peer-to-peer media, and TURN credentials when the deployment configures TURN. Signaling and screenshots go browser → relay → desktop and media goes directly, hole-punched peer to peer, or through TURN; nothing passes through the Control Plane. Only the policy’s allowed members (always including the owner) may watch; an organization viewer gets `view` mode, anyone else `control`, which may take over input. Call again before `expiresAt` to renew. 409 when the Computer is revoked or offline; 503 when no relay is configured.',
          operationId: 'createComputerViewer',
          params: IdParam,
          response: { 200: ComputerViewerGrantDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        const ctx = ctxOf(req)
        if (!c.policy.allowedMembers.includes(ctx.userId) && !canEditPolicy(c, ctx)) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'only the computer’s allowed members can watch it' })
        }
        if (c.status === 'revoked') return reply.code(409).send(revokedConflict)
        const mode = can(ctx, { action: AuthorizationAction.OrganizationWrite }) ? 'control' : 'view'
        const grant = await deps.computerViewer.grantViewer(orgOf(req), c.id, { userId: ctx.userId, mode })
        if (!grant.granted) {
          const status = grant.code === 'no_relay' ? 503 : 409
          return reply.code(status).send({
            error: status === 503 ? 'Service Unavailable' : 'Conflict',
            statusCode: status,
            message: grant.message
          })
        }
        const { granted: _granted, ...dto } = grant
        return dto
      }
    )

    // Resume loosens the human emergency brake, so API keys and agents' delegated calls cannot reach it.
    r.post(
      '/computers/:id/resume',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Resume a computer',
          description:
            'Lifts a console Stop so agents granted the Computer may take control again; the desktop daemon resumes only a pause the console caused. Only the registrant of a self-hosted Computer, or an editor of a managed one, may resume it. Idempotent.',
          operationId: 'resumeComputer',
          params: IdParam,
          response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const c = await getOrgComputer(req, req.params.id)
        if (!c) return reply.code(404).send(notFound)
        if (!canEditPolicy(c, ctxOf(req))) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'only the computer’s owner can resume it' })
        }
        if (c.status === 'revoked') return reply.code(409).send(revokedConflict)
        const resumed = await deps.computers.resume(orgOf(req), c.id, ctxOf(req).userId)
        if (!resumed) return reply.code(409).send(revokedConflict)
        return await present(req, resumed)
      }
    )

    r.put(
      '/computers/:id/policy',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set computer policy',
          description:
            'Replaces how a Computer is used (allowed members, view or control, approvals, app limits, quiet hours, lease limits, screenshot retention in days where 0 stores none). Omitted fields take their defaults. Only the registrant may change the policy of their own self-hosted desktop, and the owner always stays an allowed member. Which agents may use it is its agent access (`PUT /computers/{id}/agent-access`).',
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
        const members = await resolveShareSet(deps.repos.user, orgOf(req), req.body.allowedMembers)
        const policy = withOwnerMember({ ...req.body, allowedMembers: members }, c.ownerUserId)
        const updated = await deps.computers.setPolicy(orgOf(req), c.id, policy, ctxOf(req).userId)
        if (!updated) return reply.code(409).send(revokedConflict)
        return await present(req, updated)
      }
    )

    r.put(
      '/computers/:id/agent-access',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set computer agent access',
          description:
            'Sets which agents may use a Computer: `none` (the default), `selected` with the listed `agents`, or `all` for every agent of the organization. This is the one relation an agent’s computer use derives from, so an agent granted here gets the `computer_*` tools in its next new session without any agent-side setting. Requires edit rights on the Computer, and on a self-hosted desktop only its registrant; agents newly listed must be visible to the caller, and a Selected list keeps the existing agents the caller cannot see. An empty selection reads as `none`, and a selection past 200 agents is refused (409). A `per-agent` or `ephemeral` managed computer is used only by its own agent (409). Every change is audited.',
          operationId: 'setComputerAgentAccess',
          params: IdParam,
          body: SetComputerAgentAccessBody,
          response: { 200: ComputerDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const target = await accessTarget(req, req.params.id)
        if (!('computer' in target)) return reply.code(target.status).send(target.body)
        const c = target.computer
        const wanted: ComputerAgentAccess = { mode: req.body.mode, agents: [...new Set(req.body.agents)] }
        const visible = await visibleAgentIds(req)
        const unknown = wanted.agents.filter((id) => !visible.has(id) && !c.agentAccess.agents.includes(id))
        if (wanted.mode === 'selected' && unknown.length > 0) return reply.code(400).send(unknownAgents(unknown))
        // A deleted agent is in no caller's visible set, so only agents that still exist count as hidden.
        const existing = new Set((await deps.repos.agent.list(orgOf(req))).map((a) => a.id as string))
        const written = await writeAccess(reply, () =>
          deps.computers.setAgentAccess(
            orgOf(req),
            c.id,
            (current) => {
              if (wanted.mode !== 'selected') return wanted
              // Agents the caller cannot see keep their access, as a hidden caller grant does on an agent's call policy.
              const hidden = current.agents.filter((id) => !visible.has(id) && existing.has(id))
              return { mode: 'selected', agents: [...hidden, ...wanted.agents] }
            },
            ctxOf(req).userId
          )
        )
        if ('sent' in written) return written.sent
        return accessReply(req, reply, written.updated)
      }
    )

    r.put(
      '/computers/:id/agent-access/agents/:agentId',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Give an agent access to a computer',
          description:
            'Adds one agent to a Computer’s Selected agent access, switching it from `none` to `selected`; the same relation as `PUT /computers/{id}/agent-access`, for the agent’s own Computers list. Requires edit rights on the Computer (its registrant, for a self-hosted desktop) and a visible agent. Idempotent; a 201st agent is refused (409). A Computer granted to all agents is changed only as a whole (409), as is a `per-agent` or `ephemeral` one.',
          operationId: 'addComputerAgent',
          params: ComputerAgentParams,
          response: { 200: ComputerDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const target = await accessTarget(req, req.params.id)
        if (!('computer' in target)) return reply.code(target.status).send(target.body)
        const c = target.computer
        if (c.agentAccess.mode === 'all') return reply.code(409).send(allAgents)
        const { agentId } = req.params
        const unknown = await invisibleAgents(req, c.agentAccess.agents.includes(agentId) ? [] : [agentId])
        if (unknown.length > 0) return reply.code(400).send(unknownAgents(unknown))
        let toAll = false
        const written = await writeAccess(reply, () =>
          deps.computers.setAgentAccess(
            orgOf(req),
            c.id,
            (current) => {
              // A switch to All that landed after the read keeps it; nothing here narrows it.
              toAll = current.mode === 'all'
              if (toAll) return current
              return { mode: 'selected', agents: [...current.agents, agentId] }
            },
            ctxOf(req).userId
          )
        )
        if ('sent' in written) return written.sent
        if (toAll) return reply.code(409).send(allAgents)
        return accessReply(req, reply, written.updated)
      }
    )

    r.delete(
      '/computers/:id/agent-access/agents/:agentId',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Take an agent’s access to a computer away',
          description:
            'Removes one agent from a Computer’s Selected agent access; removing the last one leaves it `none`. The agent itself is not changed. Requires edit rights on the Computer (its registrant, for a self-hosted desktop). Idempotent. A Computer granted to all agents is changed only as a whole (409), as is a `per-agent` or `ephemeral` one.',
          operationId: 'removeComputerAgent',
          params: ComputerAgentParams,
          response: { 200: ComputerDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const target = await accessTarget(req, req.params.id)
        if (!('computer' in target)) return reply.code(target.status).send(target.body)
        const c = target.computer
        if (c.agentAccess.mode === 'all') return reply.code(409).send(allAgents)
        const { agentId } = req.params
        let toAll = false
        const updated = await deps.computers.setAgentAccess(
          orgOf(req),
          c.id,
          (current) => {
            toAll = current.mode === 'all'
            if (toAll) return current
            return { mode: current.mode, agents: current.agents.filter((id) => id !== agentId) }
          },
          ctxOf(req).userId
        )
        if (toAll) return reply.code(409).send(allAgents)
        return accessReply(req, reply, updated)
      }
    )

    r.put(
      '/computers/:id/sharing',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set computer sharing',
          description:
            'Sets who can see a Computer in the console (Everyone vs Selected). Requires edit rights; Selected must retain at least one current organization member, and a self-hosted desktop’s registrant always stays in it. Sharing grants no agent access: the Computer’s agent access decides that.',
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
        return await present(req, updated)
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
        return await present(req, revoked)
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
          description:
            'Removes a Computer and, by cascade, every key it holds. A managed computer from the pool is revoked at once, and its pod and volume are deleted before its record goes.',
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
        // A pool computer's keys go at once and its row once its pod and volume are deleted.
        if (c.kind === 'managed' && c.poolPhase && deps.computerPool) {
          await deps.computerPool.remove(orgOf(req), c.id, ctxOf(req).userId)
          return reply.code(204).send(null)
        }
        await deps.computers.delete(orgOf(req), c.id, ctxOf(req).userId)
        return reply.code(204).send(null)
      }
    )
  }
}

const noDistribution = {
  error: 'Not Found',
  statusCode: 404,
  message: 'this Control Plane ships no desktop daemon bundle'
}

const otherBundle = {
  error: 'Not Found',
  statusCode: 404,
  message: 'this Control Plane holds a different desktop bundle; retry in a minute if it is being upgraded'
}

/** The unauthenticated exchange: the registration token in the body is the credential. */
export function computerRegisterRoutes(deps: HttpDeps, opts: { hide?: boolean } = {}) {
  return async function computerRegisterRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // Public like the exchange: the installer holds no secret, and the token travels as its argument.
    r.get(
      COMPUTER_LINUX_INSTALLER_PATH,
      {
        schema: {
          ...(opts.hide ? { hide: true } : {}),
          tags: [Tag.Computers],
          summary: 'Get the Linux desktop installer',
          description:
            'A POSIX shell script that installs the desktop daemon for the current Linux desktop user on a pinned Node.js runtime, checks the bundle’s sha256, installs the systemd user service and, given `--register <token>`, registers the desktop as a Computer. 404 when this Control Plane ships no desktop daemon bundle.',
          operationId: 'getComputerLinuxInstaller',
          security: [],
          response: { 200: z.string(), 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const dist = deps.desktopDistribution
        if (!dist) return reply.code(404).send(noDistribution)
        let script: string
        try {
          script = dist.linuxInstaller(publicBaseUrl(req, deps.config))
        } catch {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'the request host is not a usable URL' })
        }
        return reply
          .header('Content-Type', 'text/x-shellscript; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(script)
      }
    )
    r.get(
      `${COMPUTER_DESKTOP_FILES_PATH}/:sha256/:file`,
      {
        schema: {
          ...(opts.hide ? { hide: true } : {}),
          tags: [Tag.Computers],
          summary: 'Download the desktop daemon',
          description:
            'The desktop daemon bundle (`agentconnect-desktop.mjs`, whose sha256 is also the `ETag`) and its third-party license notices (`agentconnect-desktop.mjs.LEGAL.txt`), as the Linux installer downloads them. The path names the bundle sha256 the installer embeds; a Control Plane holding a different bundle, such as a replica mid-upgrade, answers 404 so the installer retries.',
          operationId: 'getComputerDesktopFile',
          security: [],
          params: z.object({
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            file: z.enum([DESKTOP_BUNDLE_FILE, DESKTOP_LEGAL_FILE])
          }),
          response: {
            200: z.string(),
            304: z.null().describe('Not modified: the `If-None-Match` ETag matches'),
            404: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const dist = deps.desktopDistribution
        const body = req.params.file === DESKTOP_BUNDLE_FILE ? dist?.bundle : dist?.legal
        if (!dist || !body) return reply.code(404).send(noDistribution)
        if (req.params.sha256 !== dist.sha256) return reply.code(404).send(otherBundle)
        const etag = `"${dist.sha256}"`
        reply
          .header('ETag', etag)
          .header('Cache-Control', 'no-cache')
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Type',
            req.params.file === DESKTOP_BUNDLE_FILE ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8'
          )
        if (req.headers['if-none-match'] === etag) return reply.code(304).send(null)
        return reply.send(body)
      }
    )
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
