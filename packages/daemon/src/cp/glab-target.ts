/**
 * Target-project resolution for the `glab` wrapper (gitlab-com-integration.md
 * §13.3): explicit `-R/--repo` argument, then the `GITLAB_REPO` environment,
 * then the cwd origin remote — provider-defined precedence, resolved on the
 * Node side so sh never parses argv.
 *
 * The instance is passed in, never assumed (§24.4): the expected host is the deployment's own
 * normalized base URL, carried on the injected credential table. A target on some OTHER host defers
 * (exit 2 — the wrapper runs the real glab untouched), matching the gh wrapper's non-github
 * deferral, and a prefixed install's path prefix is stripped before the project path is read,
 * because the API takes the project path relative to the instance root.
 */
import { GITLAB_COM_BASE_URL, parseManagedBaseUrl, stripHostPathPrefix } from '../gitcred/managed-hosts.js'

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

interface ExpectedInstance {
  /** Lower-cased host including a non-default port. */
  host: string
  /** Lower-cased host without its port — the form a bare `HOST/path` argument can carry. */
  hostname: string
  pathPrefix: string
}

function expectedInstance(expectedHost: string): ExpectedInstance {
  const parts = parseManagedBaseUrl(expectedHost) ?? parseManagedBaseUrl(GITLAB_COM_BASE_URL)!
  return { host: parts.host, hostname: parts.host.replace(/:\d+$/, ''), pathPrefix: parts.pathPrefix }
}

/** The project path relative to the instance root, or undefined when the prefix does not apply. */
function projectPath(path: string, instance: ExpectedInstance): string | undefined {
  const stripped = stripHostPathPrefix(path.replace(/\.git$/i, '').replace(/\/+$/, ''), instance.pathPrefix)
  return stripped !== undefined && stripped.includes('/') ? stripped.toLowerCase() : undefined
}

/**
 * Normalize a raw project candidate. glab accepts `group/…/project` full paths,
 * `HOST/group/…/project`, and full/scp URLs for `-R`/`GITLAB_REPO`; the cwd
 * fallback hands us whatever `git remote get-url origin` prints. Unparseable ⇒
 * workspace token (project undefined); another host ⇒ defer.
 */
export function normalizeProjectArg(
  raw?: string,
  expectedHost: string = GITLAB_COM_BASE_URL
): { project?: string; defer?: boolean } {
  const s = raw?.trim()
  if (!s) return {}
  const instance = expectedInstance(expectedHost)
  // Bare namespaced path (no scheme, no scp colon) — arbitrary subgroup depth.
  if (/^[^/\s:@]+(\/[^/\s:@]+)+$/.test(s)) {
    const segs = s.replace(/\.git$/i, '').split('/')
    // `gitlab.example.test/group/project` — the HOST/path form.
    if (segs[0]!.toLowerCase() === instance.hostname) {
      const project = projectPath(segs.slice(1).join('/'), instance)
      return project ? { project } : {}
    }
    if (segs[0]!.includes('.')) return { defer: true } // some other HOST/path form
    // A bare path is already relative to the instance root, prefix included.
    return { project: segs.join('/').toLowerCase() }
  }
  const host =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+(?::\d+)?)/i.exec(s)?.[1] ?? /^[\w.-]+@([\w.-]+):/.exec(s)?.[1]
  if (host) {
    const lowered = host.toLowerCase()
    if (lowered !== instance.host && lowered !== instance.hostname) return { defer: true }
    const path = s
      .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\//i, '')
      .replace(/^[\w.-]+@[\w.-]+:/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    const project = projectPath(path, instance)
    return project ? { project } : {}
  }
  return {}
}

/** Whether an operator- or agent-supplied `GITLAB_HOST` still names the deployment's instance. */
function namesExpectedInstance(value: string, instance: ExpectedInstance): boolean {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  const parts = parseManagedBaseUrl(withScheme)
  if (!parts) return false
  return parts.host === instance.host && parts.pathPrefix === instance.pathPrefix
}

export function resolveGlabTargetProject(
  argv: readonly string[],
  env: { GITLAB_REPO?: string; GITLAB_HOST?: string },
  cwdOrigin: () => string | undefined,
  expectedHost: string = GITLAB_COM_BASE_URL
): { project?: string; defer?: boolean } {
  // A GITLAB_HOST naming another instance retargets the whole CLI, so everything defers.
  const instance = expectedInstance(expectedHost)
  const host = nonEmpty(env.GITLAB_HOST)
  if (host && !namesExpectedInstance(host, instance)) return { defer: true }
  const candidate = flagRepo(argv) ?? nonEmpty(env.GITLAB_REPO) ?? cwdOrigin()
  return normalizeProjectArg(candidate, expectedHost)
}
