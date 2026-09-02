import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeStoreDir } from '../paths.js'
import { execFileNpmCommand, type NpmCommandRunner } from './runtime-store.js'

// npm can leave an install tree whose lockfile names a platform package that node_modules lacks:
// reifying an in-place upgrade removes the old aliased optional package without adding the new one.
// The adapter then starts fine and dies the moment it spawns its real binary, and every retry fails
// identically, so the daemon stages the agent out of its roster over a repairable install.
const MISSING_PACKAGE_RE = /Missing optional dependency\s+(\S+)/i

// npm's own name grammar, so a crafted error string can never name a URL, a path, or an alias spec.
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

// Cap the scan: the store holds one tree per adapter, never thousands. A scope is its own level.
const MAX_TREES = 64
const MAX_DEPTH = 2

/** One repairable tree: `pkg` is declared by `tree`'s lockfile but missing from its node_modules. */
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

function storeTrees(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || found.length >= MAX_TREES) continue
      const path = join(dir, entry.name)
      if (existsSync(join(path, 'package-lock.json'))) found.push(path)
      else if (depth < MAX_DEPTH) walk(path, depth + 1)
    }
  }
  walk(runtimeStoreDir(root), 1)
  return found
}

/** Locate the daemon-owned trees under `root` that declare `pkg` in their lockfile but never installed it. */
export function findRepairableTrees(root: string, pkg: string): string[] {
  return storeTrees(root).filter((tree) => !existsSync(join(tree, 'node_modules', pkg)) && declaresPackage(tree, pkg))
}

/** Plan the repair for one failed start, or undefined when nothing on disk matches the reported fault. */
export function planRuntimeInstallRepair(root: string, message: string): RuntimeInstallRepair | undefined {
  const pkg = missingRuntimePackage(message)
  if (!pkg) return undefined
  const tree = findRepairableTrees(root, pkg)[0]
  return tree ? { tree, pkg } : undefined
}

// `--ignore-scripts`: a repair only reifies an optional payload the lockfile already declares, so it
// never needs package lifecycle code that the install this repairs would already have run.
const REPAIR_ARGS = ['install', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund']

/** Reinstall the missing package in place. Resolves true only when it is present afterwards. */
export async function repairRuntimeInstall(
  plan: RuntimeInstallRepair,
  run: NpmCommandRunner = execFileNpmCommand()
): Promise<boolean> {
  await run(REPAIR_ARGS, { cwd: plan.tree })
  return existsSync(join(plan.tree, 'node_modules', plan.pkg))
}
