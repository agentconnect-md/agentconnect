import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
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
 *
 * Attached spellings are absent deliberately: git 2.43 rejects `-ccore.pager=x` and
 * `--config=k=v` as unknown options itself, so a pattern for them would guard nothing.
 */
const REFUSED_ARGUMENT = [
  /^-c$/, // ad-hoc config: -c core.pager=… / -c protocol.ext.allow=always
  /^--exec-path/, // relocates git's helper binaries
  /^--upload-pack/,
  /^--receive-pack/,
  /^--config-env/
]

/**
 * Short aliases that reach execution for ONE subcommand, where the same spelling is ordinary
 * elsewhere — so the check has to be subcommand-aware rather than a blanket ban.
 *
 * `git clone -u <program>` is `--upload-pack` and runs the program (measured, git 2.43), while
 * `status -u` is `--untracked-files` and `fetch -u` is `--update-head-ok`; the daemon sends both
 * of those. `git config -e` opens `GIT_EDITOR`, also measured, and no call site edits config.
 */
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  clone: [/^-u$/],
  config: [/^-e$/, /^--edit$/]
}

/**
 * Per-stream output ceiling.
 *
 * The result travels as ONE shim frame, and `MAX_FRAME_BYTES` is 256 KiB — so a 32 MiB buffer
 * did not mean "large results are allowed", it meant a large result was assembled and then
 * dropped by the transport, taking the channel with it. A quarter of the frame per stream keeps
 * both plus JSON escaping inside the envelope, and exceeding it now surfaces as a refusal the
 * caller can report rather than a disconnect it has to diagnose.
 */
const MAX_STREAM_BYTES = 64 * 1024

/** Shell convention for a signalled child, so a killed git is never mistaken for exit 0. */
const SIGNAL_EXIT_BASE = 128
const SIGNAL_NUMBERS: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }

export interface ExecHandlerDeps {
  /** Root the sandbox permits work inside; a cwd outside it is refused. */
  workspaceRoot: string
  /** Ceiling on the caller-supplied deadline, so a hung child cannot pin the channel. */
  timeoutMs?: number
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

/** Applied when the caller names no deadline; the ceiling bounds one that is too generous. */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 15 * 60_000

export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecRefusedError'
  }
}

/** Resolve symlinks before comparing: a lexical prefix check passes for `<root>/link` even when
 *  the link points outside, so containment has to be decided on canonical paths. */
function canonical(path: string): string {
  try {
    return realpathSync(normalize(resolve(path)))
  } catch {
    // git needs an existing cwd anyway; refusing here says why instead of leaving git to.
    throw new ExecRefusedError(`cwd does not resolve: ${path}`)
  }
}

/** Refuse a cwd that escapes the workspace root, whatever the daemon asked for. */
function resolveCwd(root: string, requested: string | undefined): string {
  const base = canonical(root)
  if (!requested) return base
  if (!isAbsolute(requested)) throw new ExecRefusedError('cwd must be absolute')
  const target = canonical(requested)
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
  const perSubcommand = REFUSED_SUBCOMMAND_ARGUMENT[subcommand] ?? []
  for (const argument of parsed.args) {
    if (REFUSED_ARGUMENT.some((pattern) => pattern.test(argument))) {
      // These reach execution through git rather than around it, so the subcommand being
      // permitted is not sufficient.
      throw new ExecRefusedError(`argument ${argument} is refused`)
    }
  }
  for (const argument of rest) {
    if (perSubcommand.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused for git ${subcommand}`)
    }
  }
  const cwd = resolveCwd(deps.workspaceRoot, parsed.cwd)
  // The caller's deadline governs, bounded by this side's ceiling: a compromised daemon must not
  // be able to pin a child here indefinitely, and a child outliving the request that asked for
  // it keeps holding index.lock after the caller has given up.
  const timeoutMs = Math.min(parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.timeoutMs ?? MAX_TIMEOUT_MS)
  return await new Promise<GitExecResult>((resolvePromise, reject) => {
    execFile(
      'git',
      parsed.args,
      {
        cwd,
        // The env REPLACES rather than extends, matching the contract: the daemon sanitizes it,
        // and merging the sandbox's own environment back in would undo that.
        ...(parsed.env ? { env: parsed.env } : {}),
        timeout: timeoutMs,
        // A killed git leaves index.lock behind, so the timeout is a last resort rather than
        // the primary cancellation path — the daemon aborting its request is.
        killSignal: 'SIGTERM',
        maxBuffer: MAX_STREAM_BYTES
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; signal?: string | null; killed?: boolean }) | null
        if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          // Must precede the killed check: Node kills the child on overflow, so this would
          // otherwise be reported as a timeout.
          reject(
            new ExecRefusedError(
              `git ${subcommand} produced more than ${MAX_STREAM_BYTES} bytes on one stream, which does not fit a shim frame`
            )
          )
          return
        }
        if (failure && (failure.killed === true || typeof failure.signal === 'string')) {
          // A signalled child has NO exit code — Node reports `code: null`, `signal: SIGTERM`.
          // Mapping that to 0 was the dangerous case: a timed-out `status` came back as success
          // with partial output, which every caller reads as a clean tree, and a timed-out
          // `rev-parse` as an empty HEAD. Non-zero makes it a failure the daemon raises.
          const signal = failure.signal ?? ''
          resolvePromise({
            code: SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[signal] ?? 0),
            stdout: String(stdout),
            stderr: `${String(stderr)}\ngit ${subcommand} was terminated${signal ? ` by ${signal}` : ''} after ${timeoutMs}ms`
          })
          return
        }
        if (failure && typeof failure.code === 'string') {
          // Spawn-level failure (git missing, cwd gone): not an exit code, so report it as one
          // the daemon can distinguish from a git-level refusal.
          reject(new ExecRefusedError(`git could not be run: ${failure.message}`))
          return
        }
        resolvePromise({
          code: typeof failure?.code === 'number' ? failure.code : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })
}
