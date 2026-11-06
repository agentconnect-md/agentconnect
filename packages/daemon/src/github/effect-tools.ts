// GitHub's effect tools: pull requests, issues and comments, grouped by object in GitHub's own words.
import {
  changeRequestTool,
  commentTool,
  issueTool,
  type CodeHostEffectTool,
  type HostWords
} from '../mcp/ops/code-host.js'

const GITHUB: HostWords = {
  provider: 'github',
  prefix: 'github',
  host: 'GitHub',
  changeRequest: 'pull request',
  changeSubject: 'pull_request',
  repo: 'repository',
  draftInTitle: false,
  mergeMethods: ['merge', 'squash', 'rebase'],
  threads: false
}

export const GITHUB_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  changeRequestTool(GITHUB),
  issueTool(GITHUB),
  commentTool(GITHUB)
]
