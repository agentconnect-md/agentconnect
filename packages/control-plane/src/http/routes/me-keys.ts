/**
 * `http/routes/me-keys.ts` — the caller's own personal API keys (C2, root surface
 * like `/me`: identity-scoped, outside the org boundary).
 *
 *   GET    /me/keys                 → active keys you own, across all your orgs (never the secret/hash)
 *   POST   /me/keys                 → mint a key in ONE of your orgs (default 90-day expiry); plaintext once
 *   PATCH  /me/keys/:id             → edit name / expiry / permission / agents in place; the secret is unchanged
 *   POST   /me/keys/:id/regenerate  → new secret under the same row and settings; plaintext once, old value dead
 *   DELETE /me/keys/:id             → revoke one of your own keys (kill switch)
 *
 * A personal key acts as YOU, with your role, in the org it was minted for
 * (daemon-api-key-auth.md §8) — permissions are per-org, so every key names an org.
 * These routes are identity-scoped (no `/orgs/:orgId` prefix); the create body
 * carries the target org, verified against the caller's membership.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { UserApiKeyView } from '../../ports.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { isAgentLevelPermission } from '../../domain/api-key-permission.js'
import { canView } from '../../authorization/policy.js'
import {
  UserApiKeyListDto,
  UserApiKeyDto,
  MintedUserKeyDto,
  CreateUserKeyBody,
  UpdateUserKeyBody,
  IdParam,
  ErrorDto,
  type UserApiKeyDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

function toDto(v: UserApiKeyView): UserApiKeyDtoT {
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

export function meKeyRoutes(deps: HttpDeps) {
  // Ownership: only the caller's OWN keys — a foreign (or unknown) key id must read as absent, never get touched.
  const findOwned = async (req: FastifyRequest, id: string): Promise<UserApiKeyView | undefined> => {
    const owned = await deps.apiKeys.listForUser(req.principal!.userId, { includeRevoked: true })
    return owned.find((k) => k.id === id)
  }
  // A selected agent must exist in the key's org and be visible to the caller; anything else reads as absent, like a foreign org.
  const agentsVisible = async (orgId: string, agentIds: readonly string[], userId: string): Promise<boolean> => {
    const role = await deps.repos.org.roleOf(orgId, userId)
    if (!role) return false
    const ctx = { userId, role }
    for (const id of agentIds) {
      const agent = await deps.repos.agent.get(OrgId(orgId), AgentId(id))
      if (!agent || !canView(agent, ctx)) return false
    }
    return true
  }

  return async function meKeyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/me/keys',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'List your API keys',
          description:
            'Your active personal API keys across every organization you belong to, never exposing the secret or its hash.',
          operationId: 'listMyApiKeys',
          response: { 200: UserApiKeyListDto }
        }
      },
      async (req) => {
        const rows = await deps.apiKeys.listForUser(req.principal!.userId)
        return rows.map(toDto)
      }
    )

    r.post(
      '/me/keys',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Create an API key',
          description:
            'Mints a personal API key in one of your organizations (default 90-day expiry; pass `expiresInDays: null` for a non-expiring key). The key acts as you, with your role in that org, within its `permission`: `full` (the default), `read` (GET only), or `agent:chat` (the agent chat API for the agents in `agents` — `all`, or ids of agents you can see in that org). The plaintext is returned exactly once and is never retrievable afterward.',
          operationId: 'createMyApiKey',
          body: CreateUserKeyBody,
          response: { 201: MintedUserKeyDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        // A personal key must not be able to mint more keys — a leaked key can't
        // self-propagate new credentials (it can only ever act, then be revoked).
        if (req.apiKeyId) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'API keys cannot create API keys' })
        }
        // The target org must be one the caller actually belongs to — otherwise it
        // isn't theirs to mint against (reads as absent, like any foreign org).
        const role = await deps.repos.org.roleOf(req.body.orgId, req.principal!.userId)
        if (!role) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
        }
        const agentIds = Array.isArray(req.body.agents) ? [...new Set(req.body.agents)] : undefined
        if (agentIds && !(await agentsVisible(req.body.orgId, agentIds, req.principal!.userId))) {
          return notFound(reply, 'agent not found')
        }
        const minted = await deps.apiKeys.mintForUser({
          userId: req.principal!.userId,
          orgId: req.body.orgId,
          ...(req.body.name ? { name: req.body.name } : {}),
          expiresInDays: req.body.expiresInDays,
          permission: req.body.permission,
          ...(req.body.agents !== undefined ? { agents: agentIds ?? 'all' } : {})
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
      '/me/keys/:id',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Edit an API key',
          description:
            'Edits one of your own API keys in place: `name` (`null` clears it), `expiresInDays` (a new lifetime from now, or `null` for a non-expiring key), `permission`, and for an agent-level permission `agents` (`all`, or ids of agents you can see in the key’s organization). The secret does not change, so the key keeps working; use regenerate for a new value. Switching to `agent:chat` requires `agents`; `full` and `read` refuse it and clear any selection. A request authenticated by an API key cannot edit keys, and a revoked key cannot be edited.',
          operationId: 'updateMyApiKey',
          params: IdParam,
          body: UpdateUserKeyBody,
          response: { 200: UserApiKeyDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        // Same rule as minting: a leaked key must not be able to widen or extend itself.
        if (req.apiKeyId) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'API keys cannot edit API keys' })
        }
        const target = await findOwned(req, req.params.id)
        if (!target) return notFound(reply, 'key not found')
        if (target.revokedAt) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'key is revoked' })
        }
        // The selection rules are judged against the permission the key will have after the edit.
        const permission = req.body.permission ?? target.permission
        if (req.body.agents !== undefined && !isAgentLevelPermission(permission)) {
          return badRequest(reply, 'agents applies only to an agent-level permission')
        }
        if (isAgentLevelPermission(permission) && !isAgentLevelPermission(target.permission) && !req.body.agents) {
          return badRequest(reply, `agents is required for the ${permission} permission`)
        }
        const agentIds = Array.isArray(req.body.agents) ? [...new Set(req.body.agents)] : undefined
        if (agentIds && !(await agentsVisible(target.orgId, agentIds, req.principal!.userId))) {
          return notFound(reply, 'agent not found')
        }
        const updated = await deps.apiKeys.update(target.id, {
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.expiresInDays !== undefined ? { expiresInDays: req.body.expiresInDays } : {}),
          ...(req.body.permission !== undefined ? { permission: req.body.permission } : {}),
          ...(req.body.agents !== undefined ? { agents: agentIds ?? 'all' } : {})
        })
        return toDto({ ...target, ...updated })
      }
    )

    r.post(
      '/me/keys/:id/regenerate',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Regenerate an API key',
          description:
            'Replaces the secret of one of your own API keys. The key keeps its id, name, permission, agents and expiry; the previous value stops working immediately and the new plaintext is returned exactly once. A request authenticated by an API key cannot regenerate keys, and a revoked key cannot be regenerated.',
          operationId: 'regenerateMyApiKey',
          params: IdParam,
          response: { 200: MintedUserKeyDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (req.apiKeyId) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'API keys cannot regenerate API keys' })
        }
        const target = await findOwned(req, req.params.id)
        if (!target) return notFound(reply, 'key not found')
        if (target.revokedAt) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'key is revoked' })
        }
        const minted = await deps.apiKeys.regenerate(target.id)
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
      '/me/keys/:id',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Revoke an API key',
          description:
            'Revokes one of your own API keys as a kill switch; the next request presenting it is rejected. A key id that isn’t yours reads as absent (404).',
          operationId: 'revokeMyApiKey',
          params: IdParam,
          response: { 200: UserApiKeyDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const target = await findOwned(req, req.params.id)
        if (!target) return notFound(reply, 'key not found')
        if (target.revokedAt) return toDto(target) // already revoked → no-op, no second audit write
        const revoked = await deps.apiKeys.revoke(req.params.id, 'revoked by user')
        // `revoke` returns the base view (no org fields) — merge the fresh revokedAt
        // onto the org-labeled row we already have.
        return toDto({ ...target, revokedAt: revoked.revokedAt })
      }
    )
  }
}
