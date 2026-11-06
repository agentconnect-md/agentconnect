// GitLab's effect tools (gitlab-com-integration.md §14.2): every broker operation, named and described in GitLab's own words.
import { obj } from '../tool-schema/descriptor.js'
import { BROKER_PIPELINE_STATUSES } from '../codehost/broker.js'
import {
  brokerSubject,
  codeHostEffectTool,
  commentArgs,
  CONTROL_PIPELINE_ARGS,
  CREATE_CHANGE_REQUEST_ARGS,
  INSPECT_PIPELINES_ARGS,
  readDiscussionsArgs,
  replyDiscussionArgs,
  UPDATE_CHANGE_REQUEST_ARGS,
  updateChangeRequestOperation,
  updateCommentArgs,
  type CodeHostEffectTool
} from '../mcp/ops/code-host.js'

const SUBJECTS = ['issue', 'merge_request'] as const
const subject = { type: 'string', enum: [...SUBJECTS] }
const iid = { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' }

export const GITLAB_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: false,
    args: commentArgs(SUBJECTS),
    operation: (args) => ({ kind: 'createComment', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'createGitlabComment',
      description:
        'Post one comment on a GitLab issue or merge request in this session’s project. Requires comment ' +
        'authority. Returns the created comment id, which is the only id `updateGitlabComment` will accept later ' +
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
    provider: 'gitlab',
    readOnly: false,
    args: updateCommentArgs(SUBJECTS),
    operation: (args) => ({ kind: 'updateComment', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'updateGitlabComment',
      description:
        'Rewrite a GitLab comment THIS session created through the broker. Any other comment is refused, so the ' +
        'single author of a brokered comment stays its only editor. Requires comment authority.',
      inputSchema: obj(
        {
          subject,
          iid,
          noteId: {
            type: 'string',
            pattern: '^[1-9][0-9]*$',
            description: 'The comment id returned by an earlier createGitlabComment or replyGitlabDiscussion call.'
          },
          body: { type: 'string', minLength: 1, description: 'The complete replacement body.' }
        },
        ['subject', 'iid', 'noteId', 'body']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: true,
    args: readDiscussionsArgs(SUBJECTS),
    operation: (args) => ({ kind: 'readDiscussions', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'readGitlabDiscussions',
      description:
        'Read the discussion threads on a GitLab issue or merge request. Omit `discussionId` for a bounded list of ' +
        'the subject’s threads, or supply one to read that single thread. Read-only, so a read-level authorization ' +
        'is enough.',
      inputSchema: obj(
        {
          subject,
          iid,
          discussionId: {
            type: 'string',
            description: 'Read exactly this thread; omit to list the subject’s threads.'
          },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum threads to list (default 20).' }
        },
        ['subject', 'iid']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: false,
    args: replyDiscussionArgs(SUBJECTS),
    operation: (args) => ({ kind: 'replyDiscussion', ...args, subject: brokerSubject(args.subject) }),
    descriptor: {
      name: 'replyGitlabDiscussion',
      description:
        'Add one reply to an existing discussion thread on a GitLab issue or merge request. Use this instead of a ' +
        'new top-level comment when answering in place. Requires comment authority.',
      inputSchema: obj(
        {
          subject,
          iid,
          discussionId: { type: 'string', description: 'The thread id from readGitlabDiscussions.' },
          body: { type: 'string', minLength: 1, description: 'Complete Markdown reply body.' }
        },
        ['subject', 'iid', 'discussionId', 'body']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: false,
    args: CREATE_CHANGE_REQUEST_ARGS,
    operation: (args) => ({ kind: 'createMergeRequest', ...args }),
    guidance: 'On GitLab, open and edit merge requests with `createGitlabMergeRequest` and `updateGitlabMergeRequest`.',
    descriptor: {
      name: 'createGitlabMergeRequest',
      description:
        'Open a GitLab merge request in this session’s project from an already-pushed branch. Only the fields below ' +
        'are settable — there is no arbitrary payload. Requires write authority.',
      inputSchema: obj(
        {
          sourceBranch: {
            type: 'string',
            minLength: 1,
            description: 'The branch holding the changes (already pushed).'
          },
          targetBranch: { type: 'string', minLength: 1, description: 'The branch to merge into.' },
          title: { type: 'string', minLength: 1, description: 'Merge-request title.' },
          description: { type: 'string', description: 'Merge-request description in Markdown.' },
          draft: { type: 'boolean', description: 'Open it as a draft (marks the title accordingly).' }
        },
        ['sourceBranch', 'targetBranch', 'title']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: false,
    args: UPDATE_CHANGE_REQUEST_ARGS,
    operation: (args) => updateChangeRequestOperation(args, 'merge-request'),
    descriptor: {
      name: 'updateGitlabMergeRequest',
      description:
        'Edit an existing GitLab merge request’s title, description, target branch, or draft state. Supply at ' +
        'least one of them; everything else is left untouched. Requires write authority.',
      inputSchema: obj(
        {
          iid: { type: 'integer', minimum: 1, description: 'The merge request’s project-scoped number (IID).' },
          title: { type: 'string', description: 'Replacement title.' },
          description: { type: 'string', description: 'Replacement description in Markdown.' },
          targetBranch: { type: 'string', description: 'Retarget the merge request at this branch.' },
          draft: { type: 'boolean', description: 'Set or clear draft state (requires `title` to re-mark it).' }
        },
        ['iid']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: true,
    args: INSPECT_PIPELINES_ARGS,
    operation: (args) => ({ kind: 'inspectPipelines', ...args }),
    descriptor: {
      name: 'inspectGitlabPipelines',
      description:
        'Inspect GitLab CI in this session’s project: list recent pipelines, read one pipeline, list a pipeline’s ' +
        'jobs, or read one job. Read-only, so a read-level authorization is enough. Results are bounded.',
      inputSchema: obj(
        {
          scope: {
            type: 'string',
            enum: ['pipelines', 'pipeline', 'pipeline_jobs', 'job'],
            description:
              '`pipelines` lists recent pipelines; `pipeline` and `pipeline_jobs` need `pipelineId`; `job` needs `jobId`.'
          },
          pipelineId: {
            type: 'string',
            pattern: '^[1-9][0-9]*$',
            description: 'Required for `pipeline`/`pipeline_jobs`.'
          },
          jobId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for `job`.' },
          ref: { type: 'string', description: 'Only for `pipelines`: filter by branch or tag.' },
          status: {
            type: 'string',
            enum: [...BROKER_PIPELINE_STATUSES],
            description: 'Only for `pipelines`: filter by pipeline status.'
          },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum entries to list (default 20).' }
        },
        ['scope']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'gitlab',
    readOnly: false,
    args: CONTROL_PIPELINE_ARGS,
    operation: (args) => ({ kind: 'controlPipeline', ...args }),
    descriptor: {
      name: 'controlGitlabPipeline',
      description:
        'Retry or cancel a GitLab pipeline or a single job in this session’s project. Requires write authority; ' +
        'nothing else about the pipeline can be changed here.',
      inputSchema: obj(
        {
          action: {
            type: 'string',
            enum: ['retry_pipeline', 'cancel_pipeline', 'retry_job', 'cancel_job'],
            description: 'Pipeline actions need `pipelineId`; job actions need `jobId`.'
          },
          pipelineId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for the pipeline actions.' },
          jobId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Required for the job actions.' }
        },
        ['action']
      )
    }
  })
]
