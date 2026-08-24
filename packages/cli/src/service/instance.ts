/**
 * Named service instances — how one host runs several daemon services side by
 * side. The instance identity is still `<root>` (every daemon resource is
 * root-relative); `--instance <name>` is the human handle that names the unit
 * and, when no `--root` is given, picks the default root `~/.agentconnect-<name>`.
 *
 * The default (unnamed) instance keeps the historical unit names byte-for-byte,
 * so an existing install is never orphaned by an upgrade of this CLI.
 *
 * `<root>/service.json` is the reverse pointer: install writes the instance name
 * there so a later command that only knows the root — notably the CP-commanded
 * `upgrade --to <v> --root <root>` the daemon spawns — resolves the same unit
 * instead of the default one.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultRoot, resolveRoot, servicePointerPath } from '../paths.js'
import { findInstanceUnit, type DiscoveryScope } from './discover.js'

/** Instance names must be safe in a systemd unit name AND a launchd label, and
 *  short enough to keep `<root>/run/mcp.sock` under the ~104-byte UDS cap. */
const INSTANCE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function assertInstanceName(name: string): string {
  if (!INSTANCE_NAME.test(name)) {
    throw new Error(
      `invalid instance name ${JSON.stringify(name)} — use 1-32 chars of a-z, 0-9, '-' or '_', starting with a letter or digit`
    )
  }
  return name
}

/** The root a named instance owns when `--root` is not given. */
export function instanceRoot(name: string): string {
  return `${defaultRoot()}-${assertInstanceName(name)}`
}

/**
 * Resolve the (root, instance) pair a command operates on:
 *
 * - an explicit `--root` always wins — an operator may point a named instance at
 *   any directory;
 * - otherwise a named instance takes the root ITS INSTALLED UNIT drives, since
 *   the unit on disk is the authority. Without this, `--instance dev restart`
 *   would restart a unit running `/srv/ac-dev` while `--instance dev chat`
 *   delegated to `~/.agentconnect-dev` — one selector, two daemons. The
 *   `~/.agentconnect-<name>` default applies only when nothing is installed yet;
 * - a bare `--root` with no `--instance` adopts the instance recorded in that root.
 */
export function resolveServiceTarget(opts: { root?: string; instance?: string } & DiscoveryScope = {}): {
  root: string
  instance?: string
} {
  const named = opts.instance === undefined ? undefined : assertInstanceName(opts.instance)
  const scope: DiscoveryScope = {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {})
  }
  const root =
    opts.root !== undefined
      ? resolveRoot(opts.root)
      : named
        ? (findInstanceUnit(named, scope)?.root ?? instanceRoot(named))
        : resolveRoot()
  const instance = named ?? readInstancePointer(root)
  return { root, ...(instance ? { instance } : {}) }
}

/**
 * The selector to reproduce in a suggested follow-up command, so an operator who
 * copies it addresses the target they are working on instead of the default one.
 * `--root` travels along whenever the root is not the instance's own default —
 * spelling it out is always correct (an explicit root wins), and never assumes
 * the unit that resolution would consult is still installed.
 */
export function commandSelector(target: { root?: string; instance?: string }): string {
  const parts: string[] = []
  if (target.instance) parts.push(`--instance ${target.instance}`)
  const implied = target.instance ? instanceRoot(target.instance) : defaultRoot()
  if (target.root !== undefined && resolve(target.root) !== resolve(implied)) {
    parts.push(`--root ${shellArg(target.root)}`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** Quote a path for a command line the operator will paste back into a shell. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Should the unit carry `AGENTCONNECT_ROOT`? Only a non-default root needs it —
 *  computed from the resolved root, NOT from whether a flag was typed, so an
 *  `AGENTCONNECT_ROOT`-driven install cannot write a unit that points elsewhere. */
export function shouldBakeRootEnv(root: string): boolean {
  return root !== defaultRoot()
}

interface ServicePointer {
  instance?: string
  label: string
}

/** The instance name recorded in `<root>/service.json`, if any. */
export function readInstancePointer(root: string): string | undefined {
  const file = servicePointerPath(root)
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ServicePointer
    return typeof raw.instance === 'string' && INSTANCE_NAME.test(raw.instance) ? raw.instance : undefined
  } catch {
    return undefined // unreadable pointer — treat the root as the default instance
  }
}

/** Record which unit owns this root. Best-effort: a write failure must not fail
 *  an install that already wrote the unit. */
export function writeInstancePointer(root: string, pointer: ServicePointer): void {
  try {
    writeFileSync(servicePointerPath(root), JSON.stringify(pointer, null, 2) + '\n')
  } catch {
    // ignore — the pointer is a convenience, `--instance` still addresses the unit
  }
}

export function clearInstancePointer(root: string): void {
  rmSync(servicePointerPath(root), { force: true })
}
