// Azure DevOps's effect tools (azure-devops-integration.md §6.6): pull requests and their comment threads, in Azure DevOps's own words; work items are not repository issues.
import { z } from 'zod'
import { obj } from '../tool-schema/descriptor.js'
import { optionalBoundedInt, requiredPositiveInt } from '../mcp/ops/args.js'
import {
  changeRequestTool,
  codeHostEffectTool,
  commentTool,
  optionalDecimalId,
  type CodeHostEffectTool,
  type HostWords
} from '../mcp/ops/code-host.js'

const AZURE_DEVOPS: HostWords = {
  provider: 'azure-devops',
  prefix: 'azureDevOps',
  host: 'Azure DevOps',
  changeRequest: 'pull request',
  changeSubject: 'pull_request',
  repo: 'repository',
  draftInTitle: false,
  mergeMethods: ['merge', 'squash', 'rebase'],
  threads: true,
  mergeNote:
    'Completes it in the background: read it back to see `completed`. The target branch’s policies still apply.',
  issues: false,
  omits: ['assignees', 'reviewers']
}

const READ_THREADS_ARGS = z.object({
  iid: requiredPositiveInt('iid'),
  threadId: optionalDecimalId('threadId'),
  limit: optionalBoundedInt('limit', 1, 20)
})

export const AZURE_DEVOPS_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  changeRequestTool(AZURE_DEVOPS),
  commentTool(AZURE_DEVOPS),
  codeHostEffectTool({
    provider: 'azure-devops',
    readOnly: true,
    args: READ_THREADS_ARGS,
    operation: ({ threadId, ...args }) => ({
      kind: 'readDiscussions',
      ...args,
      subject: 'merge_request',
      ...(threadId !== undefined ? { discussionId: threadId } : {})
    }),
    descriptor: {
      name: 'readAzureDevOpsPullRequest',
      description:
        'Read an Azure DevOps pull request with its newest comment threads, or supply `threadId` to read one ' +
        'thread. Read-only, so a read-level authorization is enough.',
      inputSchema: obj(
        {
          iid: { type: 'integer', minimum: 1, description: 'The pull request number.' },
          threadId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Read exactly this thread.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum entries to list (default 20).' }
        },
        ['iid']
      )
    }
  })
]
