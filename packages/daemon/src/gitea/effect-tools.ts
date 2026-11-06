// Gitea's effect tools (gitea-integration.md §10.2): pull requests, issues and comments grouped by object, plus its reads, in Gitea's own words.
import { z } from 'zod'
import { obj } from '../tool-schema/descriptor.js'
import { BROKER_PIPELINE_STATUSES } from '../codehost/broker.js'
import { optionalBoundedInt, optionalEnum, requiredEnum, requiredPositiveInt, requiredString } from '../mcp/ops/args.js'
import {
  brokerSubject,
  changeRequestTool,
  codeHostEffectTool,
  commentTool,
  issueTool,
  optionalDecimalId,
  type CodeHostEffectTool,
  type HostWords
} from '../mcp/ops/code-host.js'

const SUBJECTS = ['issue', 'pull_request'] as const
const subject = { type: 'string', enum: [...SUBJECTS] }
const iid = { type: 'integer', minimum: 1, description: 'The issue or pull request number.' }

// Gitea comments are not threaded: one comment id reads that comment, its absence reads the subject with its comments.
const READ_COMMENTS_ARGS = z.object({
  subject: requiredEnum('subject', SUBJECTS),
  iid: requiredPositiveInt('iid'),
  commentId: optionalDecimalId('commentId'),
  limit: optionalBoundedInt('limit', 1, 20)
})

// Gitea's run state is a commit status (§10.4), read by ref.
const INSPECT_STATUSES_ARGS = z.object({
  ref: requiredString('ref'),
  status: optionalEnum('status', BROKER_PIPELINE_STATUSES),
  limit: optionalBoundedInt('limit', 1, 20)
})

const GITEA: HostWords = {
  provider: 'gitea',
  prefix: 'gitea',
  host: 'Gitea',
  changeRequest: 'pull request',
  changeSubject: 'pull_request',
  repo: 'repository',
  draftInTitle: true,
  mergeMethods: ['merge', 'squash', 'rebase'],
  threads: false
}

export const GITEA_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  changeRequestTool(GITEA),
  issueTool(GITEA),
  commentTool(GITEA),
  codeHostEffectTool({
    provider: 'gitea',
    readOnly: true,
    args: READ_COMMENTS_ARGS,
    operation: ({ commentId, ...args }) => ({
      kind: 'readDiscussions',
      ...args,
      subject: brokerSubject(args.subject),
      ...(commentId !== undefined ? { discussionId: commentId } : {})
    }),
    descriptor: {
      name: 'readGiteaComments',
      description:
        'Read a Gitea issue or pull request with its comments, and a pull request’s reviews. Gitea comments are not ' +
        'threaded: supply `commentId` to read one comment instead. Read-only, so a read-level authorization is enough.',
      inputSchema: obj(
        {
          subject,
          iid,
          commentId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Read exactly this comment.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum entries to list (default 20).' }
        },
        ['subject', 'iid']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitea',
    readOnly: true,
    args: INSPECT_STATUSES_ARGS,
    operation: (args) => ({ kind: 'inspectPipelines', scope: 'pipelines', ...args }),
    descriptor: {
      name: 'inspectGiteaStatuses',
      description:
        'Read the commit statuses Gitea reports for a branch, tag, or commit in this session’s repository. ' +
        'Read-only, so a read-level authorization is enough. Results are bounded.',
      inputSchema: obj(
        {
          ref: { type: 'string', minLength: 1, description: 'The branch, tag, or commit SHA.' },
          status: { type: 'string', enum: [...BROKER_PIPELINE_STATUSES], description: 'Filter by status.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum entries to list (default 20).' }
        },
        ['ref']
      )
    }
  })
]
