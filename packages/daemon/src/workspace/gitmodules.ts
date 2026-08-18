import { gitRepoLabel } from '@agentconnect.md/protocol'

// `.gitmodules` is git config, and decision 11 of docs/designs/multi-repository-workspaces.md needs
// exactly one thing out of it: which repositories a root already carries as submodules. Reading the
// file directly keeps that a text question — no `git config -f` subprocess, no submodule lifecycle.

/** Every `url` value under a `[submodule …]` section, in file order. */
export function parseGitmoduleUrls(text: string): string[] {
  const urls: string[] = []
  let inSubmodule = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const section = /^\[([^\]]*)\]/.exec(trimmed)
    if (section) {
      inSubmodule = /^submodule(?:[\s."]|$)/i.test(section[1]!.trim())
      continue
    }
    if (!inSubmodule) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    if (trimmed.slice(0, separator).trim().toLowerCase() !== 'url') continue
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
    if (value) urls.push(value)
  }
  return urls
}

// Only an absolute github.com address names a repository this daemon can also hold as a root. A
// relative submodule URL resolves against the superproject's own remote, and any other host is a
// repository the App never covers — both are simply not the same repository as any root.
const SCP_ADDRESS = /^[\w.-]+@([\w.-]+):(?!\/)/
const URL_ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)\//i

/** Lowercased `owner/repo` for a github.com submodule URL; undefined for anything else. */
export function githubSubmoduleRepo(url: string): string | undefined {
  const raw = url.trim()
  if (!raw || raw.startsWith('.') || raw.startsWith('/')) return undefined
  const host =
    SCP_ADDRESS.exec(raw)?.[1] ?? URL_ADDRESS.exec(raw)?.[1] ?? (/^github\.com\//i.test(raw) ? 'github.com' : undefined)
  if (host === undefined || host.replace(/:\d+$/, '').toLowerCase() !== 'github.com') return undefined
  const segments = gitRepoLabel(raw).split('/')
  if (segments.length !== 2 || segments.some((segment) => !segment)) return undefined
  return segments.join('/').toLowerCase()
}

/** The github.com repositories a `.gitmodules` file declares as submodules, lowercased. */
export function gitmoduleRepos(text: string): Set<string> {
  const repos = new Set<string>()
  for (const url of parseGitmoduleUrls(text)) {
    const repo = githubSubmoduleRepo(url)
    if (repo) repos.add(repo)
  }
  return repos
}
