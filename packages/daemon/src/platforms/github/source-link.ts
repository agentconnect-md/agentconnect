import type { GithubHookMetadata, HookContext } from '@agentconnect.md/protocol'

/**
 * GitHub's source-thread link strategy. The relay supplies `html_url` from the
 * signature-verified event envelope; the daemon still constrains it to the
 * expected github.com repository before exposing it as clickable session
 * metadata. This is presentation only and never participates in routing or
 * authorization.
 */
export function githubSourceThreadUrl(
  context: HookContext | undefined,
  github?: GithubHookMetadata
): string | undefined {
  if (context?.source !== 'github' || !context.htmlUrl) return undefined
  try {
    const url = new URL(context.htmlUrl)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase().replace(/\.+$/, '') !== 'github.com' ||
      url.port ||
      url.username ||
      url.password
    ) {
      return undefined
    }

    const repo = github?.repoFullName ?? context.repo
    if (repo) {
      const expected = repo.split('/')
      const actual = url.pathname.split('/').filter(Boolean).slice(0, 2).map(decodeURIComponent)
      if (
        expected.length !== 2 ||
        actual.length !== 2 ||
        actual[0]!.toLowerCase() !== expected[0]!.toLowerCase() ||
        actual[1]!.toLowerCase() !== expected[1]!.toLowerCase()
      ) {
        return undefined
      }
    }
    return context.htmlUrl
  } catch {
    return undefined
  }
}
