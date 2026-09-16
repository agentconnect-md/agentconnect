// A generateNotes plugin: semantic-release concatenates every plugin's notes, so this only returns the footer.
// Accepts the https, ssh and scp-like remote forms semantic-release may resolve; drops userinfo, port and .git.
function repositoryWebUrl(repositoryUrl) {
  if (!repositoryUrl) return null
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(repositoryUrl)
  const normalized = scpLike ? `ssh://${scpLike[1]}/${scpLike[2]}` : repositoryUrl.replace(/^git\+/, '')
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    return null
  }
  const path = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!parsed.hostname || !path) return null
  return `https://${parsed.hostname}${path}`
}

export function generateNotes(_pluginConfig, { lastRelease, nextRelease, options }) {
  const webUrl = repositoryWebUrl(options?.repositoryUrl)
  if (!webUrl || !nextRelease?.gitTag) return ''
  // No previous tag on a channel's first release; GitHub's own generated notes link the tag's commits there.
  const target = lastRelease?.gitTag
    ? `${webUrl}/compare/${lastRelease.gitTag}...${nextRelease.gitTag}`
    : `${webUrl}/commits/${nextRelease.gitTag}`
  return `**Full Changelog**: ${target}`
}
