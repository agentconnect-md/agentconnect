// The `srt` strategy's boundary (session-executors.md §5): SRT around the whole shim, its policy composed here from the environment and this machine's own paths; a holder sends none.
import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sandboxWrap, SandboxError, writeSandboxSettingsUnder, type SrtSandboxPolicy } from '../acp/sandbox.js'
import { AF_UNIX_PATH_MAX, SANDBOX_TEMP_DIR_ENV, WIDEST_SRT_SOCKET } from '../acp/sandbox-temp.js'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { canonicalPath, compactReadRoots, contains, protectedSandboxRoots } from '../runtimes/read-roots.js'
import type { HostShimBoundary, HostShimLayout } from './host-shim.js'

export interface SrtShimPolicyInput {
  daemonRoot: string
  /** This machine's agents directory when it is outside the daemon root: its agents' state is no hosted session's to read. */
  agentsRoot?: string
  layout: Pick<HostShimLayout, 'runtimeRoot' | 'workspaceRoot' | 'home' | 'helperRoot'>
  /** SRT's short temp root under the runtime root, where its proxy sockets fit the AF_UNIX budget. */
  tempDir: string
  /** The environment's mounts at their host paths: the session's own state, a sign-in the HOME points at, operator mounts. */
  mounts: SandboxMount[]
  /** Where the sandbox starts and anchors SRT's own protections, when that is not the root; a mount must grant it. */
  cwd?: string
  /** Code this machine runs inside: node and the runtime installs, never state. */
  readRoots: string[]
  hostEnv: NodeJS.ProcessEnv
}

/** The policy, the directory the sandbox starts in, and the read roots dropped because they would reopen a protected path. */
export function srtShimPolicy(input: SrtShimPolicyInput): { policy: SrtSandboxPolicy; cwd: string; skipped: string[] } {
  const { layout, hostEnv } = input
  const canonical = (path: string): string => canonicalPath(path, hostEnv)
  const protectedPaths = protectedSandboxRoots({
    daemonRoot: input.daemonRoot,
    scopeDir: input.daemonRoot,
    agentsRoot: input.agentsRoot,
    hostEnv
  })
  const boundary = protectedPaths.boundary.map(canonical)
  const runtimeState = protectedPaths.runtimeState.map(canonical)
  // An exception may sit below a hidden root, or equal one runtime's state root, but never reopen HOME, daemon state, temp or another's state.
  const reopens = (path: string): string | undefined =>
    boundary.find((denied) => contains(path, denied)) ??
    runtimeState.find((denied) => path !== denied && contains(path, denied))
  const exception = (path: string, label: string): string => {
    const trusted = canonical(path)
    const reopened = reopens(trusted)
    if (reopened) throw new SandboxError(`${label} "${trusted}" would reopen protected path "${reopened}"`)
    return trusted
  }
  // The root is written only as a mount names it: a session's directory is its own, but an agent's holds its agent.json.
  const mounted = input.mounts
    .filter((mount) => mount.mode === 'writable')
    .map((mount) => exception(mount.source, 'mount'))
  const grantsWrite = (path: string) => mounted.some((root) => contains(root, canonical(path)))
  // The provider starts the sandbox in a write root: the root, or the host cwd an agent-scoped environment names, where a runtime wrapped alone starts too.
  const start = input.cwd ?? layout.workspaceRoot
  if (!grantsWrite(start)) throw new SandboxError(`environment start "${start}" is not a writable mount`)
  const cwd = canonical(start)
  // Each listed exactly, not compacted: the provider requires the cwd, the HOME and the temp root to be write roots themselves.
  const writable = [
    ...new Set([
      cwd,
      exception(layout.home, 'environment HOME'),
      exception(layout.runtimeRoot, 'runtime root'),
      exception(input.tempDir, 'SRT temp root'),
      ...mounted
    ])
  ]
  const skipped: string[] = []
  const readRoots = input.readRoots.map(canonical).filter((path) => {
    if (!reopens(path)) return true
    skipped.push(path)
    return false
  })
  const policy: SrtSandboxPolicy = {
    writable,
    denyRead: compactReadRoots([...boundary, ...runtimeState]),
    allowRead: compactReadRoots([
      ...writable,
      exception(layout.helperRoot, 'shim bundle'),
      ...readRoots,
      ...input.mounts.filter((mount) => mount.mode !== 'writable').map((mount) => exception(mount.source, 'mount'))
    ]),
    // No `.git` deny beyond SRT's own at the start: a session's holder Git runs inside, as in a VM, and a runtime wrapped alone could already write its config.
    gitSafeDirectories: [cwd]
  }
  return { policy, cwd, skipped }
}

/** SRT around the shim: the provider runs from the shim's own bundle, hands it stdio alone, and ends the sandbox when this daemon dies. */
export function srtShimBoundary(input: {
  daemonRoot: string
  agentsRoot?: string
  mounts: SandboxMount[]
  cwd?: string
  readRoots: string[]
  hostEnv?: NodeJS.ProcessEnv
  log?: Pick<Logger, 'warn'>
}): HostShimBoundary {
  return {
    wrap: (shim, layout) => {
      // Short and under the runtime root, never the session HOME: SRT's multiplexer socket sits directly under TMPDIR.
      const tempDir = join(layout.runtimeRoot, 't')
      const socket = join(tempDir, WIDEST_SRT_SOCKET)
      if (Buffer.byteLength(socket) > AF_UNIX_PATH_MAX)
        throw new Error(
          `daemon root is too long for an srt shim: its SRT socket would exceed ${AF_UNIX_PATH_MAX} bytes`
        )
      mkdirSync(tempDir, { mode: 0o700 })
      const { policy, cwd, skipped } = srtShimPolicy({
        daemonRoot: input.daemonRoot,
        ...(input.agentsRoot ? { agentsRoot: input.agentsRoot } : {}),
        layout,
        tempDir,
        mounts: input.mounts,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        readRoots: input.readRoots,
        hostEnv: input.hostEnv ?? process.env
      })
      for (const path of skipped)
        input.log?.warn(`srt: not reopening ${path} for a shim — it would expose a protected path`)
      // Outside every path the sandbox can write, so nothing inside rewrites the policy it runs under.
      const settingsPath = writeSandboxSettingsUnder(
        input.daemonRoot,
        relative(input.daemonRoot, layout.privateDir),
        policy
      )
      const launch = sandboxWrap(shim.cmd, shim.args, {
        mechanism: 'bwrap',
        writable: policy.writable,
        settingsPath,
        cwd,
        provider: { cmd: process.execPath, args: [...layout.entry.execArgv, layout.entry.path] }
      })
      return { ...launch, env: { [SANDBOX_TEMP_DIR_ENV]: tempDir } }
    }
  }
}
