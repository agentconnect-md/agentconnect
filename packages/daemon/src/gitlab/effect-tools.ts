// GitLab's effect tools (gitlab-com-integration.md §14.2): merge requests, issues, comments and pipelines, grouped by object in GitLab's own words.
import { obj } from '../tool-schema/descriptor.js'
import { BROKER_PIPELINE_STATUSES } from '../codehost/broker.js'
import {
  brokerSubject,
  changeRequestTool,
  codeHostEffectTool,
  commentTool,
  CONTROL_PIPELINE_ARGS,
  INSPECT_PIPELINES_ARGS,
  issueTool,
  readDiscussionsArgs,
  type CodeHostEffectTool,
  type HostWords
} from '../mcp/ops/code-host.js'

const SUBJECTS = ['issue', 'merge_request'] as const
const subject = { type: 'string', enum: [...SUBJECTS] }
const iid = { type: 'integer', minimum: 1, description: 'The subject’s project-scoped number (IID).' }

const GITLAB: HostWords = {
  provider: 'gitlab',
  prefix: 'gitlab',
  host: 'GitLab',
  changeRequest: 'merge request',
  changeSubject: 'merge_request',
  repo: 'project',
  draftInTitle: true,
  mergeMethods: ['merge', 'squash', 'rebase'],
  threads: true,
  mergeNote: 'With a pipeline running, it merges once the pipeline passes; rebase rebases first and takes no sha.'
}

export const GITLAB_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  changeRequestTool(GITLAB),
  issueTool(GITLAB),
  commentTool(GITLAB),
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
      name: 'gitlabPipeline',
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
