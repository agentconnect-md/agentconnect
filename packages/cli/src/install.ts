/**
 * Install a daemon version into the store (cli-daemon-split.md §5.1): resolve from
 * the registry → verify integrity → engines check → extract to `versions/<v>.tmp`
 * → atomic rename to `versions/<v>`. Idempotent: an already-installed version is a
 * no-op success. Must run inside the version lock (version-lock.ts).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { nodeSatisfies } from './node-engines.js'
import { versionDir, versionsDir } from './paths.js'
import { downloadTarball, resolveDaemonTarget, verifyTarball, type ResolvedTarget } from './registry.js'
import { isInstalled, type Channel } from './version-store.js'

/**
 * A pinned `--to` version. Rejects anything that is not a plain version token —
 * notably a leading `-`, which would make the value look like a second option to
 * any argv scan that sees it. The value can originate from the Control Plane (the
 * daemon spawns `upgrade --to <version>`), so it is not the operator's own typing.
 */
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** Resolve the version to install/upgrade to, without downloading. `async` so a
 *  rejected version surfaces as a rejected promise, matching the declared type
 *  rather than throwing before the caller has one to catch. */
export async function resolveTarget(opts: { to?: string; channel: Channel }): Promise<ResolvedTarget> {
  if (opts.to !== undefined && !VERSION_TOKEN.test(opts.to)) {
    throw new Error(`invalid version ${JSON.stringify(opts.to)}`)
  }
  return resolveDaemonTarget(opts)
}

/**
 * Ensure `target.version` is installed under `versions/<v>`. Returns the version.
 * If already present, returns immediately (idempotent). `onLog` surfaces progress.
 */
export async function installTarget(
  root: string,
  target: ResolvedTarget,
  onLog: (msg: string) => void = () => {}
): Promise<string> {
  if (isInstalled(root, target.version)) {
    onLog(`daemon ${target.version} already installed`)
    return target.version
  }

  // Fail before downloading if the version declares an incompatible Node.
  if (!nodeSatisfies(target.enginesNode, process.versions.node)) {
    throw new Error(
      `daemon ${target.version} requires Node ${target.enginesNode} but this CLI runs on ${process.versions.node} — upgrade Node first`
    )
  }

  onLog(`downloading daemon ${target.version}…`)
  const buf = await downloadTarball(target.tarball)
  verifyTarball(buf, target)

  const dest = versionDir(root, target.version)
  const tmp = `${dest}.tmp`
  mkdirSync(versionsDir(root), { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    // npm tarballs wrap everything under `package/`; --strip-components=1 lands
    // dist/ + package.json directly in tmp. tar reads the tarball from stdin.
    execFileSync('tar', ['-xzf', '-', '-C', tmp, '--strip-components=1'], { input: buf })

    // Re-verify engines against the authoritative extracted manifest.
    const manifest = JSON.parse(readFileSync(`${tmp}/package.json`, 'utf8')) as { engines?: { node?: string } }
    if (!nodeSatisfies(manifest.engines?.node, process.versions.node)) {
      throw new Error(
        `daemon ${target.version} requires Node ${manifest.engines?.node} but this CLI runs on ${process.versions.node}`
      )
    }
    if (!existsSync(`${tmp}/dist/index.js`)) {
      throw new Error(`daemon ${target.version} tarball has no dist/index.js — refusing to install`)
    }

    // Atomic publish. A racing install that already produced `dest` wins; drop tmp.
    if (existsSync(dest)) {
      rmSync(tmp, { recursive: true, force: true })
    } else {
      renameSync(tmp, dest)
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
  onLog(`installed daemon ${target.version}`)
  return target.version
}
