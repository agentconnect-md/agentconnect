// Organization research's code-host reads (assistant-mode.md §5.15 "Code hosts"): the repositories in reach, and one part of one of them.
import { z } from 'zod'
import { REPOSITORY_PARTS, type RepositoryPart } from '../../codehost/repository-research.js'
import { isResearchCoordinate } from '../../session/subsession-coordinate.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs, requiredEnum, requiredString } from './args.js'
import type { SessionContext } from './context.js'

export const LIST_CODE_HOST_REPOSITORIES_ARGS = z.object({})

export const READ_CODE_HOST_REPOSITORY_ARGS = z.object({
  repository: requiredString('repository').max(256, 'argument repository must be at most 256 characters'),
  part: requiredEnum('part', REPOSITORY_PARTS as [RepositoryPart, ...RepositoryPart[]])
})

export const LIST_CODE_HOST_REPOSITORIES_TOOL: ToolDescriptor = {
  name: 'listCodeHostRepositories',
  description:
    'List the code-host repositories you may read for the organization: your workspace repository, the ones you ' +
    'were authorized for, and those your installation grants cover. Each has its path, provider, how it is in ' +
    'reach, whether readCodeHostRepository can read it, and the description its host publishes. Read-only.',
  inputSchema: obj({})
}

export const READ_CODE_HOST_REPOSITORY_TOOL: ToolDescriptor = {
  name: 'readCodeHostRepository',
  description:
    'Read one part of one repository listCodeHostRepositories listed; any other is refused. `overview`: its ' +
    'description, topics, default branch, whether it is private, and the first 8 KB of its README. `owners`: its ' +
    'CODEOWNERS file (up to 16 KB) and, over merged changes of the last 90 days, how many reviews each person gave ' +
    'per top-level path. `releases`: its last 20 releases, else its tags. Read-only.',
  inputSchema: obj(
    {
      repository: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'The path listCodeHostRepositories gave, such as example-org/example-repo.'
      },
      part: { type: 'string', enum: [...REPOSITORY_PARTS], description: 'Which part to read.' }
    },
    ['repository', 'part']
  )
}

/** Both reads, in the order research is offered them. */
export const CODE_HOST_RESEARCH_TOOLS: ToolDescriptor[] = [
  LIST_CODE_HOST_REPOSITORIES_TOOL,
  READ_CODE_HOST_REPOSITORY_TOOL
]

export interface CodeHostResearchDeps {
  /** The daemon's reads: from its own records and the Control Plane's, with credentials the runtime never sees. */
  codeHostResearch?: {
    list(ctx: SessionContext): Promise<unknown>
    read(ctx: SessionContext, input: { repository: string; part: RepositoryPart }): Promise<unknown>
  }
}

function port(ctx: SessionContext, deps: CodeHostResearchDeps, name: string) {
  if (!isResearchCoordinate(ctx.thread))
    throw new Error(`${name} is offered to organization research only; nothing was read`)
  if (!deps.codeHostResearch) throw new Error(`${name} is unavailable on this daemon; nothing was read`)
  return deps.codeHostResearch
}

export async function listCodeHostRepositories(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostResearchDeps
): Promise<unknown> {
  parseArgs(LIST_CODE_HOST_REPOSITORIES_ARGS, args)
  return await port(ctx, deps, 'listCodeHostRepositories').list(ctx)
}

export async function readCodeHostRepository(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostResearchDeps
): Promise<unknown> {
  const input = parseArgs(READ_CODE_HOST_REPOSITORY_ARGS, args)
  return await port(ctx, deps, 'readCodeHostRepository').read(ctx, input)
}
