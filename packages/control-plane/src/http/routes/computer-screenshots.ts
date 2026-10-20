// Stored Computer screenshots (computer-use.md §9): read access is the session's visibility intersected with the Computer's.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { computerScreenshotRef } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ComputerScreenshotRecord } from '../../persistence/ports.js'
import { ComputerId, SessionId } from '../../domain/ids.js'
import { orgOf, ctxOf } from '../rbac.js'
import { canView, canViewSession } from '../../authorization/policy.js'
import { makeSessionAccessResolver } from '../session-access.js'
import type { SignedScreenshotUrl } from '../../computer-screenshots/bucket.js'
import {
  ComputerScreenshotDto,
  ComputerScreenshotListQuery,
  ComputerScreenshotPageDto,
  ComputerScreenshotParams,
  ComputerScreenshotSessionParam,
  ErrorDto
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const notFound = { error: 'Not Found', statusCode: 404, message: 'screenshot not found' }

const encodeCursor = (r: ComputerScreenshotRecord): string =>
  Buffer.from(`${r.takenAt.toISOString()}|${r.id}`).toString('base64url')

function decodeCursor(cursor: string): { takenAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|')
  const date = new Date(at ?? '')
  return id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(date.getTime()) ? { takenAt: date, id } : null
}

const toDto = (r: ComputerScreenshotRecord, url: SignedScreenshotUrl) => ({
  ref: computerScreenshotRef(r.sha256),
  sha256: r.sha256,
  computerId: r.computerId,
  agentId: r.agentId,
  takenAt: r.takenAt.toISOString(),
  bytes: r.bytes,
  contentType: r.contentType,
  expiresAt: r.expiresAt.toISOString(),
  url: url.url,
  urlExpiresAt: new Date(url.expiresAt).toISOString()
})

export function computerScreenshotRoutes(deps: HttpDeps) {
  return async function computerScreenshotRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const sessionAccess = makeSessionAccessResolver(deps)

    // The session must be one the caller may view; an invisible session reads as absent.
    const sessionVisible = async (req: FastifyRequest, sessionId: string): Promise<boolean> => {
      const session = await deps.repos.session.get(orgOf(req), SessionId(sessionId))
      if (!session) return false
      const access = await sessionAccess.forSessions(req, [session])
      return canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess)
    }

    // A Computer the caller cannot see, or one deleted since, hides its screenshots too.
    const computerVisibility = (req: FastifyRequest) => {
      const seen = new Map<string, Promise<boolean>>()
      return (computerId: string): Promise<boolean> => {
        let verdict = seen.get(computerId)
        if (!verdict) {
          verdict = deps.repos.computer
            .get(orgOf(req), ComputerId(computerId))
            .then((c) => !!c && canView(c, ctxOf(req)))
          seen.set(computerId, verdict)
        }
        return verdict
      }
    }

    r.get(
      '/sessions/:sessionId/computer-screenshots',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'List a session’s computer screenshots',
          description:
            'Lists the screenshots stored for a session’s computer use, oldest first, each with a short-lived signed URL. The caller must be able to view both the session and the Computer a screenshot came from; others are left out. Screenshots are kept for their Computer’s retention, and none are stored when it is 0. Pass a page’s `nextCursor` back as `cursor` for later screenshots.',
          operationId: 'listSessionComputerScreenshots',
          params: ComputerScreenshotSessionParam,
          querystring: ComputerScreenshotListQuery,
          response: { 200: ComputerScreenshotPageDto, 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!(await sessionVisible(req, req.params.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const after = req.query.cursor ? decodeCursor(req.query.cursor) : undefined
        if (after === null) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'invalid cursor' })
        }
        const store = deps.computerScreenshots
        if (!store) return { screenshots: [], nextCursor: null }
        const limit = req.query.limit
        const rows = await store.list(orgOf(req), req.params.sessionId, {
          limit: limit + 1,
          ...(after ? { after } : {})
        })
        const page = rows.slice(0, limit)
        const visible = computerVisibility(req)
        const screenshots = []
        for (const row of page) {
          if (await visible(row.computerId)) screenshots.push(toDto(row, await store.sign(row)))
        }
        return { screenshots, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null }
      }
    )

    r.get(
      '/sessions/:sessionId/computer-screenshots/:sha256',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get a computer screenshot',
          description:
            'Resolves the `sha256:<hex>` reference a computer tool result carries in the session timeline to the stored screenshot and a short-lived signed URL. The caller must be able to view both the session and the Computer it came from; an expired, unconfirmed or unstored screenshot is not found.',
          operationId: 'getSessionComputerScreenshot',
          params: ComputerScreenshotParams,
          response: { 200: ComputerScreenshotDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const store = deps.computerScreenshots
        if (!store || !(await sessionVisible(req, req.params.sessionId))) return reply.code(404).send(notFound)
        const found = await store.read(orgOf(req), req.params.sessionId, req.params.sha256, computerVisibility(req))
        if (!found) return reply.code(404).send(notFound)
        return toDto(found.record, found.url)
      }
    )
  }
}
