import { addChannel, fail, publish as publishGitHubRelease, success, verifyConditions } from '@semantic-release/github'

export { addChannel, fail, success, verifyConditions }

// GitHub counts "N commits since this release" against target_commitish, which the plugin takes from branch.name.
// Our tag heads the release branch, so that count is always 0 and the line is hidden; main is what readers want.
const RELEASE_TARGET_BRANCH = 'main'

// Only target_commitish reads branch.name — prerelease and make_latest read branch.type and branch.main.
export function retargetRelease(context) {
  return { ...context, branch: { ...context.branch, name: RELEASE_TARGET_BRANCH } }
}

export async function publish(pluginConfig, context) {
  if (context.branch.type === 'prerelease') {
    context.logger.log(
      'Skip GitHub Release for prerelease %s; the git tag is still published.',
      context.nextRelease.gitTag
    )
    return
  }

  return publishGitHubRelease(pluginConfig, retargetRelease(context))
}
