import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { canView } from '../../authorization/policy.js'
import { ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { API_V1_PREFIX } from '../version.js'
import { findTool, type McpToolCtx } from '../mcp/tools.js'
import { INTERNAL_INVOCATION_AUTH_HEADER } from '../mcp/internal-invocation-auth.js'
import type { InvocationContext } from '../mcp/remote-grant-authenticator.js'

const Params = z.object({
  orgId: z.string(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid()
})
const OperationParams = Params.extend({ operationId: z.string().uuid() })
const DecisionBody = z.object({ decision: z.enum(['approve', 'deny']) }).strict()
const OperationDto = z.object({
  operationId: z.string().uuid(),
  toolName: z.string(),
  arguments: z.unknown(),
  status: z.enum(['awaiting_confirmation', 'executing', 'completed', 'failed', 'ambiguous', 'stale']),
  createdAt: z.string(),
  confirmationExpiresAt: z.string(),
  completedAt: z.string().nullable(),
  result: z.unknown().optional()
})
const ErrorDto = z.object({ error: z.string(), statusCode: z.number(), message: z.string() })

/** Thrown inside the §8 shared transaction when the attempt-fenced completion
 *  no longer matches — rolls the business mutation back with it. */
class CompletionFenceLost extends Error {
  constructor() {
    super('webchat MCP operation completion fence lost')
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function dto(operation: Awaited<ReturnType<HttpDeps['repos']['webchatMcpOperation']['get']>>) {
  if (!operation) return null
  let result: unknown
  if (operation.boundedResponse) {
    try {
      result = JSON.parse(Buffer.from(operation.boundedResponse).toString('utf8'))
    } catch {
      result = { message: 'The bounded operation result is not JSON.' }
    }
  }
  return {
    operationId: operation.id,
    toolName: operation.toolName,
    arguments: operation.canonicalArguments,
    status: operation.status,
    createdAt: operation.createdAt.toISOString(),
    confirmationExpiresAt: operation.confirmationExpiresAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
    ...(result !== undefined ? { result } : {})
  }
}

export function webchatMcpOperationRoutes(deps: HttpDeps) {
  return async function webchatMcpOperationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    const authorize = async (req: {
      params: z.infer<typeof Params>
      principal?: { userId: string }
      orgCtx?: { orgId: OrgId; userId: string; role: 'owner' | 'collaborator' | 'viewer' }
    }) => {
      const agent = await deps.repos.agent.get(AgentId(req.params.agentId))
      const userId = req.principal!.userId
      if (!agent || !agent.daemonId || agent.orgId !== req.params.orgId || !canView(agent, ctxOf(req as never)))
        return null
      const owns = await deps.repos.webchatConversation.owns({
        conversationId: req.params.conversationId,
        orgId: OrgId(req.params.orgId),
        agentId: AgentId(req.params.agentId),
        userId
      })
      return owns ? { agent, userId } : null
    }

    r.get(
      '/agents/:agentId/webchat/:conversationId/mcp-operations',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'List pending webchat MCP operations',
          description: 'Lists side-effecting AgentConnect MCP operations awaiting this conversation owner’s approval.',
          operationId: 'listWebchatMcpOperations',
          params: Params,
          response: { 200: z.array(OperationDto), 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const auth = await authorize(req)
        if (!auth)
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'conversation not found' })
        const operations = await deps.repos.webchatMcpOperation.listPending(
          req.params.conversationId,
          auth.userId,
          new Date(deps.clock.now())
        )
        return reply.send(operations.map((operation) => dto(operation)!))
      }
    )

    r.get(
      '/agents/:agentId/webchat/:conversationId/mcp-operations/:operationId',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Get a webchat MCP operation',
          description: 'Returns the pending, executing, or bounded terminal state of one delegated MCP operation.',
          operationId: 'getWebchatMcpOperation',
          params: OperationParams,
          response: { 200: OperationDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const auth = await authorize(req)
        const operation = auth ? await deps.repos.webchatMcpOperation.get(req.params.operationId) : null
        if (!operation || operation.conversationId !== req.params.conversationId || operation.userId !== auth?.userId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'operation not found' })
        }
        return reply.send(dto(operation)!)
      }
    )

    r.post(
      '/agents/:agentId/webchat/:conversationId/mcp-operations/:operationId/decision',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Decide a webchat MCP operation',
          description: 'Approves or denies one exact pending operation. Approval is the sole execution claimant.',
          operationId: 'decideWebchatMcpOperation',
          params: OperationParams,
          body: DecisionBody,
          response: { 200: OperationDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const auth = await authorize(req)
        const operation = auth ? await deps.repos.webchatMcpOperation.get(req.params.operationId) : null
        if (!operation || operation.conversationId !== req.params.conversationId || operation.userId !== auth?.userId) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'operation not found' })
        }
        const now = new Date(deps.clock.now())
        if (req.body.decision === 'deny') {
          const denied = await deps.repos.webchatMcpOperation.deny(
            operation.id,
            operation.conversationId,
            auth.userId,
            now
          )
          if (!denied)
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'operation is no longer pending' })
          return reply.send(dto(await deps.repos.webchatMcpOperation.get(operation.id))!)
        }

        const tool = findTool(operation.toolName)
        const parsed = tool?.schema.safeParse(operation.canonicalArguments)
        const expectedIntent = createHash('sha256')
          .update('agentconnect:webchat-mcp-intent:v1\0')
          .update(operation.toolName)
          .update('\0')
          .update(canonicalJson(operation.canonicalArguments))
          .digest('hex')
        if (!tool?.write || !parsed?.success || expectedIntent !== operation.intentHash) {
          await deps.repos.webchatMcpOperation.deny(operation.id, operation.conversationId, auth.userId, now)
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'operation integrity check failed' })
        }

        const executionAttemptId = randomUUID()
        const claimed = await deps.repos.webchatMcpOperation.claimForApproval({
          operationId: operation.id,
          conversationId: operation.conversationId,
          userId: auth.userId,
          executionAttemptId,
          claimedAt: now,
          recoveryDeadline: new Date(now.getTime() + 5 * 60_000)
        })
        if (!claimed)
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'operation is no longer pending' })

        const context: InvocationContext = {
          invocationId: operation.id,
          conversationId: operation.conversationId,
          grantId: operation.sourceGrantId,
          authorityGeneration: operation.createdAuthorityGeneration,
          agentId: auth.agent.id,
          daemonId: auth.agent.daemonId!,
          orgId: auth.agent.orgId,
          userId: auth.userId,
          startedAt: now,
          requestId: `operation:${operation.id}`,
          requestHash: operation.intentHash,
          method: 'tools/call',
          toolName: operation.toolName
        }
        const toolCtx: McpToolCtx = {
          orgId: auth.agent.orgId,
          delegatedAgentId: auth.agent.id,
          get: async (path, query) => {
            const qs = new URLSearchParams()
            for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) qs.set(key, String(value))
            const url = `${API_V1_PREFIX}${path}${qs.size ? `?${qs}` : ''}`
            const response = await app.inject({
              method: 'GET',
              url,
              headers: { [INTERNAL_INVOCATION_AUTH_HEADER]: deps.internalInvocationAuth.issue('GET', url)! }
            })
            return { statusCode: response.statusCode, body: response.body }
          },
          send: async (method, path, body) => {
            const url = `${API_V1_PREFIX}${path}`
            const response = await app.inject({
              method,
              url,
              headers: { [INTERNAL_INVOCATION_AUTH_HEADER]: deps.internalInvocationAuth.issue(method, url)! },
              ...(body ? { payload: body } : {})
            })
            return { statusCode: response.statusCode, body: response.body }
          }
        }

        let terminal: 'completed' | 'failed' = 'failed'
        let bounded = Buffer.from(JSON.stringify({ message: 'Tool execution failed unexpectedly.' }))
        let completed = false
        const execute = () => deps.internalInvocationAuth.run(context, () => tool.call(toolCtx, parsed.data))
        const record = (result: { statusCode: number; body: string }) => {
          terminal = result.statusCode >= 200 && result.statusCode < 300 ? 'completed' : 'failed'
          bounded = Buffer.from(JSON.stringify({ statusCode: result.statusCode, body: result.body }))
        }
        const completeAttempt = () =>
          deps.repos.webchatMcpOperation.complete({
            operationId: operation.id,
            executionAttemptId,
            status: terminal,
            boundedResponse: bounded,
            completedAt: new Date(deps.clock.now())
          })
        if (tool.effect === 'cp_db') {
          // §8: this tool's ENTIRE side effect is a CP-database mutation, so the
          // mutation and the operation's terminal transition commit in ONE
          // shared transaction — no ambiguous window. If the attempt fence was
          // lost meanwhile (reaper/concurrent transition), the whole unit rolls
          // back: the business mutation never outlives its execution claim.
          try {
            completed = await deps.sharedTx(async () => {
              record(await execute())
              if (!(await completeAttempt())) throw new CompletionFenceLost()
              return true
            })
          } catch (error) {
            if (error instanceof CompletionFenceLost) {
              return reply
                .code(409)
                .send({ error: 'Conflict', statusCode: 409, message: 'operation is no longer executing' })
            }
            // The transaction rolled back, so the mutation definitively did NOT
            // commit — an ordinary failure, never an ambiguous outcome.
            req.log.error({ err: error, operationId: operation.id }, 'webchat MCP operation execution failed')
            terminal = 'failed'
            bounded = Buffer.from(JSON.stringify({ message: 'Tool execution failed unexpectedly.' }))
            completed = await completeAttempt()
          }
        } else {
          try {
            record(await execute())
          } catch (error) {
            req.log.error({ err: error, operationId: operation.id }, 'webchat MCP operation execution failed')
          }
          completed = await completeAttempt()
        }
        if (!completed) {
          await deps.repos.webchatMcpOperation.markAmbiguous(
            operation.id,
            executionAttemptId,
            new Date(deps.clock.now())
          )
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'operation outcome is ambiguous' })
        }
        await deps.repos.audit.append({
          kind: 'mcp_tool_call',
          orgId: OrgId(auth.agent.orgId),
          actorUserId: auth.userId,
          message: operation.toolName,
          details: { principalType: 'webchat_browser_approval', operationId: operation.id, status: terminal }
        })
        return reply.send(dto(await deps.repos.webchatMcpOperation.get(operation.id))!)
      }
    )
  }
}
