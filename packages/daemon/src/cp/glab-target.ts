/**
 * Target-project resolution for the `glab` wrapper (gitlab-com-integration.md
 * §13.3): explicit `-R/--repo` argument, then the `GITLAB_REPO` environment,
 * then the cwd origin remote — provider-defined precedence, resolved on the
 * Node side so sh never parses argv. gitlab.com only: any other host defers
 * (exit 2 — the wrapper runs the real glab untouched), matching the gh
 * wrapper's non-github deferral.
 */

function nonEmpty(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** `-R x`, `--repo x`, `-R=x`, `--repo=x` — the LAST one wins, like glab. */
function flagRepo(argv: readonly string[]): string | undefined {
  let found: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') break
    if (arg === '-R' || arg === '--repo') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) found = next
    } else if (arg.startsWith('-R=')) found = arg.slice(3)
    else if (arg.startsWith('--repo=')) found = arg.slice(7)
  }
  return nonEmpty(found)
}

/**
 * Normalize a raw project candidate. glab accepts `group/…/project` full paths,
 * `HOST/group/…/project`, and full/scp URLs for `-R`/`GITLAB_REPO`; the cwd
 * fallback hands us whatever `git remote get-url origin` prints. Unparseable ⇒
 * workspace token (project undefined); a non-gitlab.com host ⇒ defer.
 */
export function normalizeProjectArg(raw?: string): { project?: string; defer?: boolean } {
  const s = raw?.trim()
  if (!s) return {}
  // Bare namespaced path (no scheme, no scp colon) — arbitrary subgroup depth.
  if (/^[^/\s:@]+(\/[^/\s:@]+)+$/.test(s)) {
    const segs = s.replace(/\.git$/i, '').split('/')
    // `gitlab.com/group/project` — the HOST/path form.
    if (segs[0]!.toLowerCase() === 'gitlab.com') {
      return segs.length >= 3 ? { project: segs.slice(1).join('/').toLowerCase() } : {}
    }
    if (segs[0]!.includes('.')) return { defer: true } // some other HOST/path form
    return { project: segs.join('/').toLowerCase() }
  }
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(s)?.[1] ?? /^[\w.-]+@([\w.-]+):/.exec(s)?.[1]
  if (host) {
    if (host.toLowerCase() !== 'gitlab.com') return { defer: true }
    const path = s
      .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\//i, '')
      .replace(/^[\w.-]+@[\w.-]+:/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    return path.includes('/') ? { project: path.toLowerCase() } : {}
  }
  return {}
}

export function resolveGlabTargetProject(
  argv: readonly string[],
  env: { GITLAB_REPO?: string; GITLAB_HOST?: string },
  cwdOrigin: () => string | undefined
): { project?: string; defer?: boolean } {
  // An explicit non-gitlab.com GITLAB_HOST retargets the whole CLI — ours only
  // answers for gitlab.com, so everything defers to the real glab.
  const host = nonEmpty(env.GITLAB_HOST)
  if (host && host.toLowerCase() !== 'gitlab.com') return { defer: true }
  const candidate = flagRepo(argv) ?? nonEmpty(env.GITLAB_REPO) ?? cwdOrigin()
  return normalizeProjectArg(candidate)
}
