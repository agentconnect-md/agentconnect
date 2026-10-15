// An anonymous Source off GitHub, resolved by the pod that will fetch it (source-cache.md §5, §6.1): never cached, never shared.
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { GitRunner } from '../workspace/git-runner.js'
import { workspaceGitEnvBase } from '../workspace/git-injection.js'
import { namingFromListing, refListingPatterns } from './git-ref-listing.js'
import { resolveBoundedGitSkillSource } from './skill-git-source.js'
import type { SkillRefPlan } from './skill-ref-resolution.js'

const COMMIT_SHA = /^[0-9a-f]{40}$/i
// No repository is discovered from the exec channel's cwd, so an agent-writable checkout config is never read.
const NO_REPOSITORY = '/nonexistent/agentconnect-skill-ref'

/** One scoped anonymous `ls-remote` over the pod's exec channel; a pinned commit is taken as given and contacts nothing. */
export async function resolveSkillRefInPod(entry: AgentSkillEntry, runner: GitRunner): Promise<SkillRefPlan> {
  let url: string
  let ref: string | undefined
  try {
    // The daemon's origin policy runs before the URL reaches the pod.
    const source = resolveBoundedGitSkillSource(entry)
    url = source.cloneUrl
    ref = source.ref
  } catch {
    return { ok: false }
  }
  if (ref !== undefined && COMMIT_SHA.test(ref)) {
    return { ok: true, commit: ref.toLowerCase(), pinned: true, credentialed: false }
  }
  const name = ref === 'HEAD' || ref === '' ? undefined : ref
  const listing = refListingPatterns(name)
  if (!listing) return { ok: false }
  try {
    const stdout = await runner
      .withEnv({ ...workspaceGitEnvBase(url), GIT_TERMINAL_PROMPT: '0', GIT_DIR: NO_REPOSITORY })
      .raw(['ls-remote', '-q', ...(listing.symref ? ['--symref'] : []), '--', url, ...listing.patterns])
    const naming = namingFromListing(stdout, name)
    if (naming.kind !== 'named') return { ok: false }
    return { ok: true, commit: naming.commit, ref: naming.ref, pinned: false, credentialed: false }
  } catch {
    return { ok: false }
  }
}
