import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'
import { runtimeStoreDir } from '../paths.js'
import { resolveCommandPath } from './probe.js'

// An ACP adapter is the runtime's PARENT process, outside every inner tool sandbox, so it must not
// load its code from anywhere the model can write. `npx -y <spec>` did exactly that: it resolved and
// installed into `$HOME/.npm/_npx/<hash>` under the agent's own private HOME, at every host spawn.
// This store installs the same package once, under the daemon root, and launches its declared bin.

/** One `npx` launch decomposed into the package the store installs and the arguments the adapter gets. */
export interface NpxPackageLaunch {
  name: string
  range: string
  /** The bin `npx -p <pkg> <bin>` named; absent means the package's own default. */
  bin?: string
  args: string[]
}

/** One installed package: the tree, the version it holds, and the bin to launch. */
export interface StoredRuntimePackage {
  tree: string
  version: string
  bin: string
}

export type NpmCommandRunner = (args: string[], opts?: { cwd?: string }) => Promise<string>

const NPX_PASSTHROUGH_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent'])
const PACKAGE_SPEC_RE = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:@([^@\s]+))?$/
// A registry answer becomes a directory name, so refuse anything that is not plainly a version.
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]*$/

/** Decompose an `npx` launch into the package the store can install, or undefined when it is not one. */
export function parseNpxLaunch(runtime: RuntimeDef): NpxPackageLaunch | undefined {
  if (runtime.command !== 'npx') return undefined
  const argv = [...runtime.args]
  let spec: string | undefined
  let bin: string | undefined
  while (argv.length > 0) {
    const arg = argv.shift()!
    if (NPX_PASSTHROUGH_FLAGS.has(arg)) continue
    if (arg === '-p' || arg === '--package') {
      spec = argv.shift()
      continue
    }
    if (arg.startsWith('--package=')) {
      spec = arg.slice('--package='.length)
      continue
    }
    // Any other flag can change what npx resolves, so leave the whole launch alone rather than guess.
    if (arg.startsWith('-')) return undefined
    if (spec) bin = arg
    else spec = arg
    break
  }
  const matched = spec ? PACKAGE_SPEC_RE.exec(spec) : null
  if (!matched) return undefined
  return { name: matched[1]!, range: matched[2] ?? 'latest', ...(bin ? { bin } : {}), args: argv }
}

/** `<root>/runtimes/<package>@<version>`, with a package scope kept as its own directory level. */
export function runtimePackageTree(root: string, name: string, version: string): string {
  const parts = name.split('/')
  return join(runtimeStoreDir(root), ...parts.slice(0, -1), `${parts.at(-1)}@${version}`)
}

// Highest first: numeric segments compare as numbers, and a prerelease sorts below its own release.
function compareVersionsDesc(a: string, b: string): number {
  const split = (version: string): [string, string] => {
    const dash = version.indexOf('-')
    return dash < 0 ? [version, ''] : [version.slice(0, dash), version.slice(dash + 1)]
  }
  const [aRelease, aPre] = split(a)
  const [bRelease, bPre] = split(b)
  const aParts = aRelease.split('.')
  const bParts = bRelease.split('.')
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const delta = (Number(bParts[i] ?? 0) || 0) - (Number(aParts[i] ?? 0) || 0)
    if (delta !== 0) return delta
  }
  if (aPre === bPre) return 0
  if (!aPre) return -1
  if (!bPre) return 1
  return bPre.localeCompare(aPre)
}

/** Versions of `name` already installed in the store, newest first. */
export function installedRuntimeVersions(root: string, name: string): string[] {
  const parts = name.split('/')
  const leaf = parts.pop()!
  try {
    return readdirSync(join(runtimeStoreDir(root), ...parts), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${leaf}@`))
      .map((entry) => entry.name.slice(leaf.length + 1))
      .filter((version) => VERSION_RE.test(version))
      .sort(compareVersionsDesc)
  } catch {
    return []
  }
}

function declaredBin(manifestBin: unknown, name: string, bin: string | undefined): string | undefined {
  const own = name.split('/').pop()!
  if (typeof manifestBin === 'string') return !bin || bin === own || bin === name ? manifestBin : undefined
  if (!manifestBin || typeof manifestBin !== 'object') return undefined
  const table = manifestBin as Record<string, string>
  if (bin) return table[bin]
  return table[own] ?? Object.values(table)[0]
}

/** The launchable bin inside an installed tree, or undefined when the tree is absent or incomplete. */
export function installedRuntimeBin(tree: string, launch: NpxPackageLaunch): string | undefined {
  const packageDir = join(tree, 'node_modules', ...launch.name.split('/'))
  let manifest: { bin?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { bin?: unknown }
  } catch {
    return undefined
  }
  const relative = declaredBin(manifest.bin, launch.name, launch.bin)
  if (!relative) return undefined
  const path = join(packageDir, relative)
  return existsSync(path) ? path : undefined
}

/** Launch the store's own install directly: no `npx`, so nothing resolves or downloads at spawn. */
export function storedRuntimeDef(
  runtime: RuntimeDef,
  launch: NpxPackageLaunch,
  installed: StoredRuntimePackage,
  node: string = process.execPath
): RuntimeDef {
  return {
    ...runtime,
    command: node,
    args: [installed.bin, ...launch.args],
    // The outer sandbox denies the daemon root; this is how the store tree is carved back read-only.
    readRoots: [...(runtime.readRoots ?? []), installed.tree]
  }
}

// npm interpolates `${VAR}` in `.npmrc` values from its environment, so a full daemon env is one
// crafted config line away from shipping a daemon secret to a registry of the author's choosing.
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

/** The minimum env npm needs. HOME stays the daemon's own, so the `.npmrc` it reads is the operator's. */
export function npmStoreEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...NPM_ENV_ALLOWLIST, 'HOME', 'USERPROFILE']) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

// Bounded because a daemon start waits on it: generous enough for a cold fetch of a large platform
// binary, short enough that a hung registry fails the install instead of parking startup forever.
const NPM_TIMEOUT_MS = 5 * 60_000

/** Run one npm command, resolving the executable against the same env — `execFile` does no PATH search. */
export function execFileNpmCommand(env: NodeJS.ProcessEnv = npmStoreEnv()): NpmCommandRunner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const npm = resolveCommandPath('npm', env) ?? 'npm'
      const options = { cwd: opts.cwd, env, timeout: NPM_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      execFile(npm, args, options, (err, stdout, stderr) =>
        err
          ? reject(new Error(`npm ${args[0] ?? ''} failed: ${(String(stderr) || err.message).trim().slice(0, 400)}`))
          : resolve(String(stdout))
      )
    })
}

export interface RuntimeStoreOptions {
  root: string
  run?: NpmCommandRunner
  log?: { info(message: string): void; warn(message: string): void }
}

/** Installs daemon-supplied ACP adapters under the daemon root and reports where to launch them. */
export class RuntimeStore {
  private readonly inFlight = new Map<string, Promise<StoredRuntimePackage>>()
  private readonly run: NpmCommandRunner

  constructor(private readonly opts: RuntimeStoreOptions) {
    this.run = opts.run ?? execFileNpmCommand()
  }

  /** One install per package for this daemon's lifetime: two hosts starting at once share this promise. */
  ensure(launch: NpxPackageLaunch): Promise<StoredRuntimePackage> {
    const key = `${launch.name}@${launch.range}${launch.bin ? `:${launch.bin}` : ''}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const run = this.install(launch)
    this.inFlight.set(key, run)
    void run.catch(() => {})
    return run
  }

  private async install(launch: NpxPackageLaunch): Promise<StoredRuntimePackage> {
    const resolved = await this.resolveVersion(launch)
    const version = resolved ?? installedRuntimeVersions(this.opts.root, launch.name)[0]
    if (!version) {
      const store = runtimeStoreDir(this.opts.root)
      throw new Error(`${launch.name}@${launch.range} could not be resolved and nothing is installed under ${store}`)
    }
    const tree = runtimePackageTree(this.opts.root, launch.name, version)
    const present = installedRuntimeBin(tree, launch)
    if (present) return { tree, version, bin: present }
    // No resolution means an unreachable registry, and the store never installs a version it did not resolve.
    if (!resolved) throw new Error(`${launch.name}@${version} is not installed at ${tree}`)
    await this.installInto(tree, `${launch.name}@${version}`)
    const bin = installedRuntimeBin(tree, launch)
    const named = launch.bin ? ` "${launch.bin}"` : ''
    if (!bin) throw new Error(`${launch.name}@${version} installed at ${tree} declares no bin${named}`)
    this.prune(launch.name, version)
    return { tree, version, bin }
  }

  /** Resolve the dist-tag ONCE per daemon start — an upgrade restarts the process, and a spawn never
   *  re-resolves; an unreachable registry falls back to whatever the store already holds. */
  private async resolveVersion(launch: NpxPackageLaunch): Promise<string | undefined> {
    let output: string
    try {
      output = await this.run(['view', `${launch.name}@${launch.range}`, 'version', '--json'])
    } catch (err) {
      this.opts.log?.warn(`runtimes: could not resolve ${launch.name}@${launch.range} — ${(err as Error).message}`)
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(output.trim() || 'null')
    } catch {
      return undefined
    }
    // A range answers with every matching version; npm prints them lowest first, so take the last.
    const version = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').at(-1)
      : typeof parsed === 'string'
        ? parsed
        : undefined
    return version && VERSION_RE.test(version) ? version : undefined
  }

  /** Install into a staging directory and rename, so a partial tree is never visible as an install. */
  private async installInto(tree: string, spec: string): Promise<void> {
    const staging = join(runtimeStoreDir(this.opts.root), `.staging-${randomUUID().slice(0, 8)}`)
    mkdirSync(staging, { recursive: true })
    try {
      // Without a manifest of its own npm walks up and installs into whatever tree it finds first.
      const manifest = { name: 'agentconnect-runtime-store', version: '0.0.0', private: true }
      writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      await this.run(['install', spec, '--no-audit', '--no-fund'], { cwd: staging })
      mkdirSync(dirname(tree), { recursive: true })
      rmSync(tree, { recursive: true, force: true })
      renameSync(staging, tree)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
  }

  /** Drop versions this daemon no longer launches; the store resolves before any host is running. */
  private prune(name: string, keep: string): void {
    for (const version of installedRuntimeVersions(this.opts.root, name)) {
      if (version === keep) continue
      try {
        rmSync(runtimePackageTree(this.opts.root, name, version), { recursive: true, force: true })
      } catch (err) {
        this.opts.log?.warn(`runtimes: could not remove ${name}@${version} — ${(err as Error).message}`)
      }
    }
  }
}
