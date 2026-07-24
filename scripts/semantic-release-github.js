import { addChannel, fail, publish as publishGitHubRelease, success, verifyConditions } from '@semantic-release/github'

export { addChannel, fail, success, verifyConditions }

export async function publish(pluginConfig, context) {
  if (context.branch.type === 'prerelease') {
    context.logger.log(
      'Skip GitHub Release for prerelease %s; the git tag is still published.',
      context.nextRelease.gitTag
    )
    return
  }

  return publishGitHubRelease(pluginConfig, context)
}
