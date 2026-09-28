// Service-account members (daemon-api-key-auth.md §6): owner-only and `interactiveOnly`, like `/me/keys`, so no key manages keys.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ServiceAccountRecord } from '../../persistence/ports.js'
import type { UserApiKeyView } from '../../ports.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { isAgentLevelPermission } from '../../domain/api-key-permission.js'
import { canView } from '../../authorization/policy.js'
import { denyNonOwner } from '../rbac.js'
import {
  CreateServiceAccountBody,
  CreateServiceAccountKeyBody,
  ErrorDto,
  IdParam,
  MintedUserKeyDto,
  ServiceAccountDto,
  ServiceAccountKeyParam,
  ServiceAccountListDto,
  UpdateServiceAccountBody,
  UpdateUserKeyBody,
  UserApiKeyDto,
  UserApiKeyListDto,
  type UserApiKeyDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

function toDto(r: ServiceAccountRecord): z.infer<typeof ServiceAccountDto> {
  return {
    userId: r.userId,
    name: r.name,
    email: r.email,
    displayName: r.displayName,
    role: r.role,
    createdAt: r.createdAt.toISOString()
  }
}

function toKeyDto(v: UserApiKeyView): UserApiKeyDtoT {
  return {
    id: v.id,
    displayTail: v.displayTail,
    name: v.name,
    orgId: v.orgId,
    orgSlug: v.orgSlug,
    orgName: v.orgName,
    permission: v.permission,
    allAgents: v.allAgents,
    agentIds: v.agentIds,
    agents: v.agents,
    createdAt: v.createdAt.toISOString(),
    lastUsedAt: v.lastUsedAt ? v.lastUsedAt.toISOString() : null,
    expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
    revokedAt: v.revokedAt ? v.revokedAt.toISOString() : null
  }
}

const notFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: 'Not Found', statusCode: 404, message })
const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: 'Bad Request', statusCode: 400, message })
const revokedConflict = (reply: FastifyReply) =>
  reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'key is revoked' })

const config = { interactiveOnly: true }

export function serviceAccountRoutes(deps: HttpDeps) {
  const findAccount = (req: FastifyRequest, id: string) => deps.repos.user.getServiceAccount(req.orgCtx!.orgId, id)
  // Only this account's keys in this org; any other key id reads as absent.
  const findKey = async (req: FastifyRequest, accountId: string, keyId: string) => {
    const keys = await deps.apiKeys.listForUser(accountId, { includeRevoked: true })
    return keys.find((k) => k.id === keyId && k.orgId === req.orgCtx!.orgId)
  }
  // A selected agent must be one the service account itself can see, as for a personal key.
  const agentsVisible = async (account: ServiceAccountRecord, orgId: string, agentIds: readonly string[]) => {
    const ctx = { userId: account.userId, role: account.role }
    for (const id of agentIds) {
      const agent = await deps.repos.agent.get(OrgId(orgId), AgentId(id))
      if (!agent || !canView(agent, ctx)) return false
    }
    return true
  }

  return async function serviceAccountRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/service-accounts',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'List service accounts',
          description: 'Owner-only. The organization’s service accounts, oldest first.',
          operationId: 'listServiceAccounts',
          response: { 200: ServiceAccountListDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        return (await deps.repos.user.listServiceAccounts(req.orgCtx!.orgId)).map(toDto)
      }
    )

    r.post(
      '/service-accounts',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Create a service account',
          description:
            'Owner-only. Creates a member that never signs in, with the role `collaborator` or `viewer`. Its address is `<name>-<id>@sa.agentconnect.md` and never changes.',
          operationId: 'createServiceAccount',
          body: CreateServiceAccountBody,
          response: { 201: ServiceAccountDto, 400: ErrorDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const created = await deps.repos.user.createServiceAccount(req.orgCtx!.orgId, req.body)
        return reply.code(201).send(toDto(created))
      }
    )

    r.patch(
      '/service-accounts/:id',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Edit a service account',
          description: 'Owner-only. Changes the display name or role; the name is part of the address and stays.',
          operationId: 'updateServiceAccount',
          params: IdParam,
          body: UpdateServiceAccountBody,
          response: { 200: ServiceAccountDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const updated = await deps.repos.user.updateServiceAccount(req.orgCtx!.orgId, req.params.id, req.body)
        return toDto(updated)
      }
    )

    r.delete(
      '/service-accounts/:id',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Delete a service account',
          description:
            'Owner-only. Removes the service account the way a member is removed, with the caller added where an audience would otherwise be empty, then deletes it with its keys and webchat conversations.',
          operationId: 'deleteServiceAccount',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        await deps.repos.user.deleteServiceAccount(req.orgCtx!.orgId, req.params.id, req.orgCtx!.userId)
        return reply.code(204).send(null)
      }
    )

    r.get(
      '/service-accounts/:id/keys',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'List a service account’s keys',
          description:
            'Owner-only. The service account’s keys, revoked included, never exposing the secret or its hash.',
          operationId: 'listServiceAccountKeys',
          params: IdParam,
          response: { 200: UserApiKeyListDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!(await findAccount(req, req.params.id))) return notFound(reply, 'service account not found')
        const keys = await deps.apiKeys.listForUser(req.params.id, { includeRevoked: true })
        return keys.filter((k) => k.orgId === req.orgCtx!.orgId).map(toKeyDto)
      }
    )

    r.post(
      '/service-accounts/:id/keys',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Create a service account key',
          description:
            'Owner-only. Mints a key that acts as the service account, with the body and policy of `POST /me/keys` minus `orgId`. The plaintext is returned exactly once.',
          operationId: 'createServiceAccountKey',
          params: IdParam,
          body: CreateServiceAccountKeyBody,
          response: { 201: MintedUserKeyDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const account = await findAccount(req, req.params.id)
        if (!account) return notFound(reply, 'service account not found')
        const agentIds = Array.isArray(req.body.agents) ? [...new Set(req.body.agents)] : undefined
        if (agentIds && !(await agentsVisible(account, orgId, agentIds))) return notFound(reply, 'agent not found')
        const minted = await deps.apiKeys.mintForUser({
          userId: account.userId,
          orgId,
          ...(req.body.name ? { name: req.body.name } : {}),
          expiresInDays: req.body.expiresInDays,
          permission: req.body.permission,
          ...(req.body.agents !== undefined ? { agents: agentIds ?? 'all' } : {}),
          createdByUserId: req.orgCtx!.userId
        })
        return reply.code(201).send({
          apiKeyId: minted.apiKeyId,
          apiKey: minted.token,
          displayTail: minted.displayTail,
          permission: minted.permission,
          allAgents: minted.allAgents,
          agentIds: minted.agentIds
        })
      }
    )

    r.patch(
      '/service-accounts/:id/keys/:keyId',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Edit a service account key',
          description:
            'Owner-only. Edits the key in place with the rules of `PATCH /me/keys/:id`; the secret does not change, and a revoked key cannot be edited.',
          operationId: 'updateServiceAccountKey',
          params: ServiceAccountKeyParam,
          body: UpdateUserKeyBody,
          response: { 200: UserApiKeyDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const account = await findAccount(req, req.params.id)
        const target = account ? await findKey(req, account.userId, req.params.keyId) : undefined
        if (!account || !target) return notFound(reply, 'key not found')
        if (target.revokedAt) return revokedConflict(reply)
        // The selection rules are judged against the permission the key will have after the edit.
        const permission = req.body.permission ?? target.permission
        if (req.body.agents !== undefined && !isAgentLevelPermission(permission)) {
          return badRequest(reply, 'agents applies only to an agent-level permission')
        }
        if (isAgentLevelPermission(permission) && !isAgentLevelPermission(target.permission) && !req.body.agents) {
          return badRequest(reply, `agents is required for the ${permission} permission`)
        }
        const agentIds = Array.isArray(req.body.agents) ? [...new Set(req.body.agents)] : undefined
        if (agentIds && !(await agentsVisible(account, target.orgId, agentIds))) {
          return notFound(reply, 'agent not found')
        }
        const updated = await deps.apiKeys.update(
          target.id,
          {
            ...(req.body.name !== undefined ? { name: req.body.name } : {}),
            ...(req.body.expiresInDays !== undefined ? { expiresInDays: req.body.expiresInDays } : {}),
            ...(req.body.permission !== undefined ? { permission: req.body.permission } : {}),
            ...(req.body.agents !== undefined ? { agents: agentIds ?? 'all' } : {})
          },
          { actorUserId: req.orgCtx!.userId }
        )
        return toKeyDto({ ...target, ...updated })
      }
    )

    r.post(
      '/service-accounts/:id/keys/:keyId/regenerate',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Regenerate a service account key',
          description:
            'Owner-only. Replaces the key’s secret and keeps every setting; the previous value stops working at once and the new plaintext is returned exactly once.',
          operationId: 'regenerateServiceAccountKey',
          params: ServiceAccountKeyParam,
          response: { 200: MintedUserKeyDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const target = (await findAccount(req, req.params.id))
          ? await findKey(req, req.params.id, req.params.keyId)
          : undefined
        if (!target) return notFound(reply, 'key not found')
        if (target.revokedAt) return revokedConflict(reply)
        const minted = await deps.apiKeys.regenerate(target.id, { actorUserId: req.orgCtx!.userId })
        return {
          apiKeyId: minted.apiKeyId,
          apiKey: minted.token,
          displayTail: minted.displayTail,
          permission: minted.permission,
          allAgents: minted.allAgents,
          agentIds: minted.agentIds
        }
      }
    )

    r.delete(
      '/service-accounts/:id/keys/:keyId',
      {
        config,
        schema: {
          tags: [Tag.Members],
          summary: 'Revoke a service account key',
          description: 'Owner-only. Revokes the key as a kill switch; the next request presenting it is rejected.',
          operationId: 'revokeServiceAccountKey',
          params: ServiceAccountKeyParam,
          response: { 200: UserApiKeyDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const target = (await findAccount(req, req.params.id))
          ? await findKey(req, req.params.id, req.params.keyId)
          : undefined
        if (!target) return notFound(reply, 'key not found')
        if (target.revokedAt) return toKeyDto(target)
        const revoked = await deps.apiKeys.revoke(target.id, 'revoked by owner', { actorUserId: req.orgCtx!.userId })
        return toKeyDto({ ...target, revokedAt: revoked.revokedAt })
      }
    )
  }
}
