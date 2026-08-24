import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCommandPath } from './probe.js'

// npm can leave an `npx` tree whose lockfile names a platform package that node_modules lacks:
// reifying an in-place upgrade removes the old aliased optional package without adding the new one.
// The adapter then starts fine and dies the moment it spawns its real binary, and every retry fails
// identically, so the daemon stages the agent out of its roster over a repairable install.
const MISSING_PACKAGE_RE = /Missing optional dependency\s+(\S+)/i

// npm's own name grammar, so a crafted error string can never name a URL, a path, or an alias spec.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

const NPX_CACHE = ['.npm', '_npx']

// Cap the scan: a private HOME holds one tree per npx package spec, never thousands.
const MAX_TREES = 64

/** One repairable npx tree: `pkg` is declared by `tree`'s lockfile but missing from its node_modules. */
export interface RuntimeInstallRepair {
  tree: string
  pkg: string
}

/** The package an adapter reported as missing, or undefined when the failure is not this class. */
export function missingRuntimePackage(message: string): string | undefined {
  // The name sits inside a sentence, so shed the terminating period; no npm name ends in one.
  const name = MISSING_PACKAGE_RE.exec(message)?.[1]?.replace(/\.$/, '')
  return name && PACKAGE_NAME_RE.test(name) ? name : undefined
}

function declaresPackage(tree: string, pkg: string): boolean {
  try {
    return readFileSync(join(tree, 'package-lock.json'), 'utf8').includes(`"node_modules/${pkg}"`)
  } catch {
    return false
  }
}

/** Locate the npx trees under `home` that declare `pkg` in their lockfile but have not installed it. */
export function findRepairableTrees(home: string, pkg: string): string[] {
  const root = join(home, ...NPX_CACHE)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, MAX_TREES)
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
  return entries.filter((tree) => !existsSync(join(tree, 'node_modules', pkg)) && declaresPackage(tree, pkg))
}

/** Plan the repair for one failed start, or undefined when nothing on disk matches the reported fault. */
export function planRuntimeInstallRepair(home: string, message: string): RuntimeInstallRepair | undefined {
  const pkg = missingRuntimePackage(message)
  if (!pkg) return undefined
  const tree = findRepairableTrees(home, pkg)[0]
  return tree ? { tree, pkg } : undefined
}

// npm reads `.npmrc` from the HOME we point it at — a directory the agent can write — and npm
// interpolates `${VAR}` in config values from the environment. Handing it the daemon's whole env
// would let an agent-authored `_authToken=${SOME_DAEMON_KEY}` ship a daemon secret to a registry of
// its choosing, no lifecycle script required. So pass an allowlist: what npm needs to reach a
// registry through this host's network, and nothing that is worth stealing.
const NPM_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  // A git-backed dependency reaches its remote through git's own bundle (§24.5).
  'GIT_SSL_CAINFO',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA'
]

/** The minimum env npm needs, pointed at the child's HOME so the reinstall lands in the very cache
 *  and lockfile the adapter's own `npx` resolves. */
export function npmRepairEnv(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of NPM_ENV_ALLOWLIST) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  env.HOME = home
  if (process.platform === 'win32') env.USERPROFILE = home
  return env
}

export type NpmRunner = (tree: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>

// Bounded because a start waits on it: generous enough for a cold fetch of a large platform
// binary, short enough that a hung registry fails the start instead of parking a turn.
const REPAIR_TIMEOUT_MS = 5 * 60_000

/** Reify one tree with the child's own env, so npm resolves the same HOME, cache, and registry.
 *  Resolves the executable against that same env — `execFile` does no PATH/PATHEXT search of its
 *  own, so a bare `npm` would be ENOENT on Windows, where it ships as `npm.cmd`. */
export const execFileNpmRunner: NpmRunner = (tree, args, env) =>
  new Promise((resolve, reject) => {
    const npm = resolveCommandPath('npm', env) ?? 'npm'
    execFile(npm, args, { cwd: tree, env, timeout: REPAIR_TIMEOUT_MS, windowsHide: true }, (err) =>
      err ? reject(err) : resolve()
    )
  })

// `--ignore-scripts` is the security boundary, not an optimization: the tree and its lockfile sit in
// the agent's own writable HOME, so running lifecycle scripts here would execute agent-authored code
// as the daemon, outside the sandbox the adapter itself is confined to.
const REPAIR_ARGS = ['install', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund']

/** Reinstall the missing package in place. Resolves true only when it is present afterwards. */
export async function repairRuntimeInstall(
  plan: RuntimeInstallRepair,
  env: NodeJS.ProcessEnv,
  runner: NpmRunner = execFileNpmRunner
): Promise<boolean> {
  await runner(plan.tree, REPAIR_ARGS, env)
  return existsSync(join(plan.tree, 'node_modules', plan.pkg))
}
