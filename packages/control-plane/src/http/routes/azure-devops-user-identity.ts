import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { AzureDevOpsApiError } from '../../azure-devops/api.js'
import { AzureDevOpsConnectDenied } from '../../azure-devops/connection.service.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { orgOf } from '../rbac.js'

export function azureDevOpsUserIdentityRoutes(deps: HttpDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    if (!deps.azureDevOps) return
    const r = app.withTypeProvider<ZodTypeProvider>()
    const errors = { 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 502: ErrorDto }
    const failed = (reply: FastifyReply, error: unknown) => {
      if (error instanceof AzureDevOpsConnectDenied)
        return reply.code(error.status).send({
          error: error.code,
          code: error.code,
          statusCode: error.status,
          message: error.message
        })
      if (error instanceof AzureDevOpsApiError || error instanceof LogtoApiError)
        return reply.code(502).send({
          error: 'Bad Gateway',
          statusCode: 502,
          message: 'Microsoft verification is temporarily unavailable — try again'
        })
      throw error
    }
    const service = () => {
      const identity = deps.azureDevOps?.userIdentity
      if (!identity)
        throw new AzureDevOpsConnectDenied(
          'Microsoft tenant verification is not configured',
          409,
          'AZURE_DEVOPS_IDENTITY_VERIFICATION_UNAVAILABLE'
        )
      return identity
    }

    r.post(
      '/azure-devops/identity/authorization',
      {
        config: { interactiveOnly: true },
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Verify your Microsoft identity in an Azure DevOps tenant',
          description:
            'Starts a single-use, user-bound Microsoft authorization with PKCE in the connected organization’s tenant. The existing console sign-in identity is unchanged.',
          operationId: 'authorizeAzureDevOpsUserIdentity',
          body: z.object({ connectionId: z.uuid() }).strict(),
          response: { 200: z.object({ authorizeUrl: z.url() }), ...errors }
        }
      },
      async (req, reply) => {
        try {
          return await service().authorize(orgOf(req), req.principal!.userId, req.body.connectionId)
        } catch (error) {
          return failed(reply, error)
        }
      }
    )

    r.post(
      '/azure-devops/identity/callback',
      {
        config: { interactiveOnly: true },
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.AzureDevOps],
          summary: 'Complete Microsoft tenant identity verification',
          description:
            'Verifies Microsoft’s identity and current sign-in link, consumes the authorization state, and retains a sealed refresh token for background identity checks. No personal token is returned to the browser or a daemon.',
          operationId: 'completeAzureDevOpsUserIdentity',
          body: z.object({ state: z.string().min(32).max(256), code: z.string().min(1).max(8192) }).strict(),
          response: { 204: z.null(), ...errors }
        }
      },
      async (req, reply) => {
        try {
          await service().complete(orgOf(req), req.principal!.userId, req.body.state, req.body.code)
          return reply.code(204).send(null)
        } catch (error) {
          return failed(reply, error)
        }
      }
    )
  }
}
