// Gitea's effect tools (gitea-integration.md §10.2): only the broker operations Gitea implements, in Gitea's own words.
import { z } from 'zod'
import { obj } from '../tool-schema/descriptor.js'
import { BROKER_PIPELINE_STATUSES } from '../codehost/broker.js'
import { optionalBoundedInt, optionalEnum, requiredEnum, requiredPositiveInt, requiredString } from '../mcp/ops/args.js'
import {
  brokerSubject,
  codeHostEffectTool,
  commentArgs,
  CREATE_CHANGE_REQUEST_ARGS,
  optionalDecimalId,
  UPDATE_CHANGE_REQUEST_ARGS,
  updateChangeRequestOperation,
  updateCommentArgs,
  type CodeHostEffectTool
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

export const GITEA_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  codeHostEffectTool({
    provider: 'gitea',
    readOnly: false,
    args: commentArgs(SUBJECTS),
    operation: (args) => ({ kind: 'createComment', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'createGiteaComment',
      description:
        'Post one comment on a Gitea issue or pull request in this session’s repository. Requires comment ' +
        'authority. Returns the created comment id, which is the only id `updateGiteaComment` will accept later ' +
        'in this session.',
      inputSchema: obj(
        {
          subject: { ...subject, description: 'Which subject family to comment on.' },
          iid,
          body: { type: 'string', minLength: 1, description: 'Complete Markdown comment body.' }
        },
        ['subject', 'iid', 'body']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitea',
    readOnly: false,
    args: updateCommentArgs(SUBJECTS),
    operation: (args) => ({ kind: 'updateComment', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'updateGiteaComment',
      description:
        'Rewrite a Gitea comment THIS session created through the broker. Any other comment is refused, so the ' +
        'single author of a brokered comment stays its only editor. Requires comment authority.',
      inputSchema: obj(
        {
          subject,
          iid,
          noteId: {
            type: 'string',
            pattern: '^[1-9][0-9]*$',
            description: 'The comment id returned by an earlier createGiteaComment call.'
          },
          body: { type: 'string', minLength: 1, description: 'The complete replacement body.' }
        },
        ['subject', 'iid', 'noteId', 'body']
      )
    }
  }),
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
    readOnly: false,
    args: CREATE_CHANGE_REQUEST_ARGS,
    operation: (args) => ({ kind: 'createMergeRequest', ...args }),
    guidance: 'On Gitea, open and edit pull requests with `createGiteaPullRequest` and `updateGiteaPullRequest`.',
    descriptor: {
      name: 'createGiteaPullRequest',
      description:
        'Open a Gitea pull request in this session’s repository from an already-pushed branch. Only the fields ' +
        'below are settable — there is no arbitrary payload. Requires write authority.',
      inputSchema: obj(
        {
          sourceBranch: {
            type: 'string',
            minLength: 1,
            description: 'The branch holding the changes (already pushed).'
          },
          targetBranch: { type: 'string', minLength: 1, description: 'The branch to merge into.' },
          title: { type: 'string', minLength: 1, description: 'Pull-request title.' },
          description: { type: 'string', description: 'Pull-request description in Markdown.' },
          draft: { type: 'boolean', description: 'Open it as a draft (marks the title accordingly).' }
        },
        ['sourceBranch', 'targetBranch', 'title']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitea',
    readOnly: false,
    args: UPDATE_CHANGE_REQUEST_ARGS,
    operation: (args) => updateChangeRequestOperation(args, 'pull-request'),
    descriptor: {
      name: 'updateGiteaPullRequest',
      description:
        'Edit an existing Gitea pull request’s title, description, target branch, or draft state. Supply at least ' +
        'one of them; everything else is left untouched. Requires write authority.',
      inputSchema: obj(
        {
          iid: { type: 'integer', minimum: 1, description: 'The pull request number.' },
          title: { type: 'string', description: 'Replacement title.' },
          description: { type: 'string', description: 'Replacement description in Markdown.' },
          targetBranch: { type: 'string', description: 'Retarget the pull request at this branch.' },
          draft: { type: 'boolean', description: 'Set or clear draft state (requires `title` to re-mark it).' }
        },
        ['iid']
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
