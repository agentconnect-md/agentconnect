// GitHub's effect tools: the pull-request operations its broker implements, in GitHub's own words.
import { z } from 'zod'
import { obj } from '../tool-schema/descriptor.js'
import { optionalBoolean, optionalString, requiredPositiveInt } from '../mcp/ops/args.js'
import { codeHostEffectTool, CREATE_CHANGE_REQUEST_ARGS, type CodeHostEffectTool } from '../mcp/ops/code-host.js'

// GitHub keeps draft state apart from the title, so a draft change needs no title.
const UPDATE_PULL_REQUEST_ARGS = z.object({
  iid: requiredPositiveInt('iid'),
  title: optionalString('title'),
  description: optionalString('description'),
  targetBranch: optionalString('targetBranch'),
  draft: optionalBoolean('draft')
})

export const GITHUB_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  codeHostEffectTool({
    provider: 'github',
    readOnly: false,
    args: CREATE_CHANGE_REQUEST_ARGS,
    operation: (args) => ({ kind: 'createMergeRequest', ...args }),
    guidance: 'On GitHub, open and edit pull requests with `createGithubPullRequest` and `updateGithubPullRequest`.',
    descriptor: {
      name: 'createGithubPullRequest',
      description:
        'Open a GitHub pull request in this session’s repository from an already-pushed branch. Only the fields ' +
        'below are settable — there is no arbitrary payload. Requires write authority.',
      inputSchema: obj(
        {
          sourceBranch: {
            type: 'string',
            minLength: 1,
            description: 'The head branch holding the changes (already pushed).'
          },
          targetBranch: { type: 'string', minLength: 1, description: 'The base branch to merge into.' },
          title: { type: 'string', minLength: 1, description: 'Pull-request title.' },
          description: { type: 'string', description: 'Pull-request body in Markdown.' },
          draft: { type: 'boolean', description: 'Open it as a draft pull request.' }
        },
        ['sourceBranch', 'targetBranch', 'title']
      )
    }
  }),
  codeHostEffectTool({
    provider: 'github',
    readOnly: false,
    args: UPDATE_PULL_REQUEST_ARGS,
    operation: (args) => {
      const { title, description, targetBranch, draft } = args
      if (title === undefined && description === undefined && targetBranch === undefined && draft === undefined) {
        throw new Error('supply at least one of title, description, targetBranch, or draft')
      }
      return { kind: 'updateMergeRequest', ...args }
    },
    descriptor: {
      name: 'updateGithubPullRequest',
      description:
        'Edit an existing GitHub pull request’s title, body, base branch, or draft state. Supply at least one of ' +
        'them; everything else is left untouched. Requires write authority.',
      inputSchema: obj(
        {
          iid: { type: 'integer', minimum: 1, description: 'The pull request number.' },
          title: { type: 'string', description: 'Replacement title.' },
          description: { type: 'string', description: 'Replacement body in Markdown.' },
          targetBranch: { type: 'string', description: 'Retarget the pull request at this base branch.' },
          draft: { type: 'boolean', description: 'Convert it to a draft (true) or mark it ready for review (false).' }
        },
        ['iid']
      )
    }
  })
]
