import { execFile } from 'node:child_process'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { applyFileSinkPayload } from './file-sink.js'
import { GitExecPayloadSchema, type GitExecResult } from './git-exec.js'
import type { ShimCapability } from './protocol.js'

/**
 * The git subcommands a sandbox will run, enforced HERE.
 *
 * The daemon declares a closed inventory, but a declaration on the sending side is not a
 * control: this process is the one that spawns git, so this is where the list has to be
 * checked. Anything else and a compromised daemon — or a bug in one — reaches arbitrary git,
 * which through `-c`, hooks and `--upload-pack` reaches arbitrary execution.
 */
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'check-ref-format',
  'clean',
  'clone',
  'config',
  'diff',
  'fetch',
  'log',
  'pull',
  'remote',
  'reset',
  'rev-list',
  'rev-parse',
  'status',
  'update-ref',
  'worktree'
])

/**
 * Argument forms refused regardless of subcommand: each turns a git invocation into an
 * arbitrary-execution primitive, so no member of the inventory above may carry one.
 */
const REFUSED_ARGUMENT = [
  /^-c$/, // ad-hoc config: -c core.pager=… / -c protocol.ext.allow=always
  /^--exec-path/, // relocates git's helper binaries
  /^--upload-pack/,
  /^--receive-pack/,
  /^--config-env/
]

export interface ExecHandlerDeps {
  /** Root the sandbox permits work inside; a cwd outside it is refused. */
  workspaceRoot: string
  /** Wall-clock ceiling per invocation, so a hung child cannot pin the channel. */
  timeoutMs?: number
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

const DEFAULT_TIMEOUT_MS = 120_000

export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecRefusedError'
  }
}

/** Refuse a cwd that escapes the workspace root, whatever the daemon asked for. */
function resolveCwd(root: string, requested: string | undefined): string {
  const base = resolve(root)
  if (!requested) return base
  if (!isAbsolute(requested)) throw new ExecRefusedError('cwd must be absolute')
  const target = normalize(resolve(requested))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ExecRefusedError('cwd escapes the workspace root')
  }
  return target
}

/**
 * Serve the shim's non-ACP capabilities inside the sandbox.
 *
 * Every check here duplicates one the daemon already made, deliberately. The daemon is the
 * trusted half and this is the half holding the filesystem: a check that only runs on the far
 * side of a channel protects nothing on this side.
 */
export function createExecHandler(
  deps: ExecHandlerDeps
): (capability: ShimCapability, payload: unknown) => Promise<unknown> {
  return async (capability, payload) => {
    if (capability === 'materialize') {
      await applyFileSinkPayload(payload)
      return null
    }
    if (capability === 'exec') return runGit(payload, deps)
    throw new ExecRefusedError(`capability ${capability} is not served by this handler`)
  }
}

async function runGit(payload: unknown, deps: ExecHandlerDeps): Promise<GitExecResult> {
  const parsed = GitExecPayloadSchema.parse(payload)
  const [subcommand, ...rest] = parsed.args
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new ExecRefusedError(`git ${subcommand ?? '(none)'} is not in the permitted inventory`)
  }
  for (const argument of parsed.args) {
    if (REFUSED_ARGUMENT.some((pattern) => pattern.test(argument))) {
      // These reach execution through git rather than around it, so the subcommand being
      // permitted is not sufficient.
      throw new ExecRefusedError(`argument ${argument} is refused`)
    }
  }
  void rest
  const cwd = resolveCwd(deps.workspaceRoot, parsed.cwd)
  return await new Promise<GitExecResult>((resolvePromise, reject) => {
    execFile(
      'git',
      parsed.args,
      {
        cwd,
        // The env REPLACES rather than extends, matching the contract: the daemon sanitizes it,
        // and merging the sandbox's own environment back in would undo that.
        ...(parsed.env ? { env: parsed.env } : {}),
        timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // A killed git leaves index.lock behind, so the timeout is a last resort rather than
        // the primary cancellation path — the daemon aborting its request is.
        killSignal: 'SIGTERM',
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code === 'string') {
          // Spawn-level failure (git missing, cwd gone): not an exit code, so report it as one
          // the daemon can distinguish from a git-level refusal.
          reject(new ExecRefusedError(`git could not be run: ${(error as Error).message}`))
          return
        }
        resolvePromise({
          code: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })
}
