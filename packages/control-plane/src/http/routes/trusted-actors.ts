/**
 * `http/routes/trusted-actors.ts` — the per-repository "Trusted users" list
 * (webhook-triggers-and-github-events.md).
 *
 * Reached through a hook because that is the row the console has in hand and the row
 * whose agent gates access (a hook is reachable iff its owning agent is viewable, edits
 * need `canEdit` — the hook-route precedent). The list itself is REPOSITORY-wide: every
 * hook row on that repository, whichever agent or subject family, reads the same list,
 * because trust is in a person, not in a family.
 *
 * The client supplies a login; the server resolves the host's numeric id through the
 * repository's own credential and stores that. No such user is 404; a host this
 * deployment cannot ask right now is 409 with the reason.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { CodeHostTrustedActorRecord, HookRecord } from '../../persistence/ports.js'
import { TrustedActorResolutionUnavailable, trustedActorRepoOf } from '../../codehost/trusted-actor.service.js'
import { HookId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { Tag } from '../plugins/openapi.js'
import {
  AddTrustedActorBody,
  ErrorDto,
  TrustedActorDto,
  TrustedActorHookParam,
  TrustedActorListDto,
  TrustedActorParam,
  type TrustedActorDtoT
} from '../dto/index.js'

function toDto(r: CodeHostTrustedActorRecord): TrustedActorDtoT {
  return {
    id: r.id,
    provider: r.provider,
    repoId: r.repoExternalId.toString(),
    actorId: r.actorExternalId.toString(),
    login: r.actorLogin,
    addedBy: r.addedByUserId,
    createdAt: r.createdAt.toISOString()
  }
}

export function trustedActorRoutes(deps: HttpDeps) {
  return async function routes(app: FastifyInstance) {
    const typed = app.withTypeProvider<ZodTypeProvider>()

    const notFound = (reply: FastifyReply, message = 'hook not found') =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message })

    // Same access boundary as the hook routes: the owning agent must be viewable, and for a
    // write, editable. A webhook-kind hook watches no repository and so carries no list.
    const codeHostHook = async (
      req: FastifyRequest,
      reply: FastifyReply,
      id: string,
      write: boolean
    ): Promise<{ hook: HookRecord; repo: NonNullable<ReturnType<typeof trustedActorRepoOf>> } | null> => {
      const hook = await deps.repos.hook.get(orgOf(req), HookId(id))
      if (!hook || !hook.agentId) {
        await notFound(reply)
        return null
      }
      const agent = await deps.repos.agent.get(orgOf(req), hook.agentId)
      if (!agent || !canView(agent, ctxOf(req))) {
        await notFound(reply)
        return null
      }
      if (write && !canEdit(agent, ctxOf(req))) {
        await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'you cannot edit this agent' })
        return null
      }
      const repo = trustedActorRepoOf(hook)
      if (!repo) {
        await reply
          .code(400)
          .send({ error: 'Bad Request', statusCode: 400, message: 'only a code-host hook has trusted users' })
        return null
      }
      return { hook, repo }
    }

    typed.get(
      '/hooks/:hookId/trusted-actors',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'List trusted users',
          description:
            "Users a maintainer vouched for on this hook's repository. They may fire its hooks exactly as a repository role-holder would; the list is shared by every hook row on the repository.",
          operationId: 'listTrustedActors',
          params: TrustedActorHookParam,
          response: { 200: TrustedActorListDto, 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const found = await codeHostHook(req, reply, req.params.hookId, false)
        if (!found) return
        return (await deps.trustedActors.list(found.hook, found.repo)).map(toDto)
      }
    )

    typed.post(
      '/hooks/:hookId/trusted-actors',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Add a trusted user',
          description:
            "Vouch for one user by login. The server resolves the host's numeric user id through the repository's own credential and stores that; re-adding refreshes the display login.",
          operationId: 'addTrustedActor',
          params: TrustedActorHookParam,
          body: AddTrustedActorBody,
          response: { 201: TrustedActorDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const found = await codeHostHook(req, reply, req.params.hookId, true)
        if (!found) return
        let added: CodeHostTrustedActorRecord | null
        try {
          added = await deps.trustedActors.add(found.hook, found.repo, req.body.login, req.orgCtx!.userId)
        } catch (e) {
          if (e instanceof TrustedActorResolutionUnavailable) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message })
          }
          throw e
        }
        if (!added) return notFound(reply, `no user named "${req.body.login}" on this host`)
        return reply.code(201).send(toDto(added))
      }
    )

    typed.delete(
      '/hooks/:hookId/trusted-actors/:actorId',
      {
        schema: {
          tags: [Tag.Hooks],
          summary: 'Remove a trusted user',
          description: 'Withdraw the vouch. The user falls back to whatever the repository role gate says.',
          operationId: 'removeTrustedActor',
          params: TrustedActorParam,
          response: { 204: z.null(), 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const found = await codeHostHook(req, reply, req.params.hookId, true)
        if (!found) return
        if (!(await deps.trustedActors.remove(found.hook, req.params.actorId))) {
          return notFound(reply, 'trusted user not found')
        }
        return reply.code(204).send(null)
      }
    )
  }
}
