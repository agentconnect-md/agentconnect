/**
 * `GET /orgs/:orgId/git/resolve` — the picking preview (git-workspace-model.md §5).
 * Runs the SAME derivation the write paths run, for the authenticated caller, and
 * returns the outcome: provider, that caller's access ceiling, canonical address,
 * default branch. The console's tiles badge and default from it, so the picker can
 * no longer disagree with the write path about what a pick means. It previews a
 * PROSPECTIVE write only — a stored workspace renders from its persisted credential.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { GitCloneUrlError, MAX_GIT_REPO_LENGTH, normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto, GitResolveDto, type GitResolveDtoT } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { GithubApiError } from '../../github/api.js'
import { GitlabApiError } from '../../gitlab/api.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { UserAuthzDeniedError } from '../../github/user-authz.js'
import { deriveWorkspaceCredential, WorkspaceCredentialRefused, type DerivedWorkspace } from './workspace-credential.js'

function toResolveDto(derived: DerivedWorkspace): GitResolveDtoT {
  return {
    provider: derived.kind === 'anonymous' ? 'anonymous' : derived.kind,
    gitRepo: derived.gitRepo,
    access: derived.access,
    ...(derived.defaultBranch !== undefined ? { defaultBranch: derived.defaultBranch } : {}),
    ...(derived.kind === 'anonymous' ? { host: derived.host } : {})
  }
}

export function gitRoutes(deps: HttpDeps) {
  const routes: FastifyPluginAsync = async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/git/resolve',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Resolve a git address',
          description:
            'Preview what writing this address as an agent workspace would derive for the calling user: who vouches for it (GitHub App installation, managed GitLab project, or an anonymous read-only clone), the caller’s access ceiling, the canonical cloneable address, and the default branch. Refusals mirror the write paths.',
          operationId: 'resolveGitRepo',
          querystring: z.object({ gitRepo: z.string().min(1).max(MAX_GIT_REPO_LENGTH) }),
          response: { 200: GitResolveDto, 400: ErrorDto, 409: ErrorDto, 429: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        const orgId = req.orgCtx!.orgId
        const actor = req.principal?.userId
        // The same input codec every write path runs; a malformed address is a 400,
        // exactly as `GitRepoInput` answers it, never an unhandled throw.
        let gitRepo: string
        try {
          gitRepo = normalizeGitCloneUrl(req.query.gitRepo)
        } catch (e) {
          if (!(e instanceof GitCloneUrlError)) throw e
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'gitRepo must be a credential-free HTTPS or SSH repository URL, or owner/repo shorthand'
          })
        }
        // The ceiling, not an enforcement: try the highest tier first, and where the
        // identity gate holds this caller below write, answer with the read tier.
        try {
          return toResolveDto(await deriveWorkspaceCredential(deps, orgId, actor, gitRepo))
        } catch (e) {
          if (e instanceof UserAuthzDeniedError) {
            try {
              return toResolveDto(await deriveWorkspaceCredential(deps, orgId, actor, gitRepo, 'read'))
            } catch (inner) {
              if (inner instanceof UserAuthzDeniedError || inner instanceof WorkspaceCredentialRefused) {
                return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: inner.message })
              }
              throw inner
            }
          }
          if (e instanceof WorkspaceCredentialRefused) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: e.message })
          }
          // Provider trouble maps as the write paths map it — an actionable status,
          // never an unhandled 500 from a preview.
          if (e instanceof LogtoApiError) {
            return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
          }
          if (e instanceof GithubApiError || e instanceof GitlabApiError) {
            const status = e.code === 'RATE_LIMITED' ? 429 : 502
            return reply.code(status).send({
              error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
              statusCode: status,
              message: e.message
            })
          }
          throw e
        }
      }
    )
  }
  return routes
}
