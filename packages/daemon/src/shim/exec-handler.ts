import { execFile } from 'node:child_process'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { applyFileSinkPayload } from './file-sink.js'
import { SANDBOX_MCP_BRIDGE_ENTRY, SANDBOX_SKILL_STAGING_DIR } from './sandbox-paths.js'
import { ClusterSkillHandler } from './skill-handler.js'
import type { ClusterSkillRequestContext } from './skill-handler.js'
import { GitExecPayloadSchema, type GitExecResult } from './git-exec.js'
import type { ShimCapability } from './protocol.js'
import { applyWorkspaceFilesPayload } from './workspace-files-channel.js'
import { applyMemoryFsPayload, isMemoryFsPayload } from './memory-fs-channel.js'

/**
 * The git subcommands a sandbox will run, enforced HERE.
 *
 * The daemon declares a closed inventory, but a declaration on the sending side is not a
 * control: this process is the one that spawns git, so this is where the list has to be
 * checked. Anything else and a compromised daemon — or a bug in one — reaches arbitrary git,
 * which through `-c`, hooks and `--upload-pack` reaches arbitrary execution.
 */
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'branch',
  'check-ref-format',
  'clean',
  'clone',
  'config',
  'diff',
  'fetch',
  'log',
  'ls-remote',
  'pull',
  'remote',
  'reset',
  'rev-list',
  'rev-parse',
  'show-ref',
  'status',
  'symbolic-ref',
  'update-ref',
  'worktree'
])

/**
 * Argument forms refused regardless of subcommand: each turns a git invocation into an
 * arbitrary-execution primitive, so no member of the inventory above may carry one.
 *
 * Matched as PREFIXES, never as exact tokens. Every one of these has at least three accepted
 * spellings — separated (`-c k=v`), attached (`-ck=v`) and long-with-equals (`--config=k=v`) —
 * all measured against git 2.43, and an exact-token list catches only the first. `-c` in
 * particular is not just a global option: `git clone -c` is clone's OWN option, which is how
 * `-cprotocol.ext.allow=always ext::<helper>` reaches a helper the caller names.
 *
 * No argv the daemon sends starts with `-c` or `--config` (`--count` does not match `/^-c/`,
 * whose second character is `c`), so the width costs nothing real.
 */
const REFUSED_ARGUMENT = [
  /^-c/, // ad-hoc config in any spelling: -c k=v, -ck=v
  /^--config/, // --config=k=v, --config-env=…
  /^--exec-path/, // relocates git's helper binaries
  /^--upload-pack/,
  /^--receive-pack/
]

/**
 * Options that reach execution for ONE subcommand, where the same spelling is ordinary
 * elsewhere — so the check has to be subcommand-aware rather than a blanket ban.
 *
 * `git clone -u <program>` is `--upload-pack` and runs the program, attached spelling included
 * (`-u<program>`); measured, not assumed. Meanwhile `status -u` is `--untracked-files` and
 * `fetch -u` is `--update-head-ok`, and the daemon sends both — a blanket `-u` refusal would
 * break every status call. `git config -e` opens `GIT_EDITOR`, also measured, and no call site
 * edits config.
 */
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  clone: [/^-u/],
  config: [/^-e$/, /^--edit/]
}

/**
 * Per-stream raw ceiling — a cheap first bound, NOT the authoritative one.
 *
 * The result travels as ONE shim frame, and `MAX_FRAME_BYTES` is 256 KiB, so a 32 MiB buffer did
 * not mean "large results are allowed": it meant a large result was assembled and then dropped
 * by the transport, taking the channel with it.
 */
const MAX_STREAM_BYTES = 64 * 1024

/**
 * The authoritative bound: the SERIALIZED size, because JSON encoding is not size-preserving.
 *
 * `git status -z` emits filenames verbatim, control bytes included, and JSON expands each one to
 * a six-byte `\uXXXX` escape — so ~57 KB of raw output measured 333 KB serialized, passing a raw
 * check and then failing the 256 KiB frame. Checking the encoded form is the only check that
 * corresponds to what the transport will accept. The headroom covers the frame envelope
 * (correlation id, capability, generation) that wraps this payload.
 */
const FRAME_ENVELOPE_HEADROOM_BYTES = 4 * 1024
const MAX_RESPONSE_BYTES = MAX_FRAME_BYTES - FRAME_ENVELOPE_HEADROOM_BYTES

/** Shell convention for a signalled child, so a killed git is never mistaken for exit 0. */
const SIGNAL_EXIT_BASE = 128
const SIGNAL_NUMBERS: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 }

/** The image's own table generator. It drives each runtime through `initialize` (and a session),
 *  so the answer is what the runtimes SAY they are, not what a manifest claims. */
const RUNTIME_TABLE_GENERATOR = '/opt/agentconnect/bin/generate-runtime-table.mjs'

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

/**
 * Refuse an operand that escapes the workspace root, for a path that does not exist yet.
 *
 * Lexical rather than `realpath`, because a clone target is precisely a path that is not there:
 * containment is decided on the normalized form, and the ROOT is canonicalized so a symlinked mount
 * still compares correctly. A RELATIVE operand is resolved against the fenced cwd first, the way git
 * itself resolves it — checking only absolute ones let `../escaped` through the fence untouched.
 */
function assertInsideRoot(root: string, cwd: string, requested: string): void {
  const base = canonical(root)
  const target = normalize(isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ExecRefusedError(`path escapes the workspace root: ${requested}`)
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
): (
  capability: ShimCapability,
  payload: unknown,
  abort?: AbortSignal,
  context?: ClusterSkillRequestContext
) => Promise<unknown> {
  const skillHandler = new ClusterSkillHandler({
    stagingRoot: SANDBOX_SKILL_STAGING_DIR,
    workspaceRoot: deps.workspaceRoot,
    stateRoot: join(deps.workspaceRoot, '.agentconnect', 'cluster-skill-state')
  })
  return async (capability, payload, abort, context) => {
    if (capability === 'materialize') {
      await applyFileSinkPayload(payload)
      return null
    }
    if (capability === 'exec') return runGit(payload, deps, abort)
    if (capability === 'probe') return probeRuntimes(deps, abort)
    if (capability === 'skills') return skillHandler.handle(payload, abort, context)
    // The console's file operations, run on the mounted volume. The mount is handed over as the
    // ANCHOR rather than the daemon's root being validated here: the operations walk to it from an
    // open descriptor, so "is this inside the mount" and "which directory is it" are one question
    // with one answer instead of two that a rename can separate.
    if (capability === 'read') {
      // The managed memory tree rides the same capability: its root is on the same mount, and the
      // primitives are walked from the same anchor by the same descent.
      if (isMemoryFsPayload(payload)) return applyMemoryFsPayload(payload, deps.workspaceRoot)
      return applyWorkspaceFilesPayload(payload, deps.workspaceRoot)
    }
    throw new ExecRefusedError(`capability ${capability} is not served by this handler`)
  }
}

/**
 * Ask this image what it provides: the runtimes, and the in-pod MCP bridge beside them.
 *
 * Runs the generator rather than reading the table it wrote at build time: the two agree by
 * construction, but a live answer cannot go stale against the image the way a copy in a ConfigMap
 * can — and that staleness is silent, because a daemon advertising a version nobody can run looks
 * exactly like a healthy one.
 */
async function probeRuntimes(deps: ExecHandlerDeps, abort?: AbortSignal): Promise<unknown> {
  return await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [RUNTIME_TABLE_GENERATOR, '-'],
      {
        cwd: resolveCwd(deps.workspaceRoot, undefined),
        timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(abort ? { signal: abort } : {}),
        maxBuffer: MAX_STREAM_BYTES
      },
      (error, stdout) => {
        if (error) {
          reject(new ExecRefusedError(`runtime probe failed: ${(error as Error).message}`))
          return
        }
        try {
          const table = JSON.parse(String(stdout)) as Record<string, unknown>
          // Consulted here rather than assumed there: whether this image ships the bridge, and
          // which interpreter runs it, are facts of THIS filesystem — and an older image, whose
          // probe simply reports neither, is the version skew the daemon has to read rather than
          // guess. `process.execPath` because the daemon must not have to trust the pod's PATH.
          const bridge = existsSync(SANDBOX_MCP_BRIDGE_ENTRY)
            ? { mcpBridge: { command: process.execPath, args: [SANDBOX_MCP_BRIDGE_ENTRY] } }
            : {}
          resolvePromise({ ...table, ...bridge })
        } catch (err) {
          reject(new ExecRefusedError(`runtime probe produced invalid JSON: ${(err as Error).message}`))
        }
      }
    )
  })
}

async function runGit(payload: unknown, deps: ExecHandlerDeps, abort?: AbortSignal): Promise<GitExecResult> {
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
  // Both WRITE a path from argv, which the cwd fence never looks at: a clone's target, and the
  // directory `worktree add`/`remove` creates or deletes. EVERY operand is checked, resolved as git
  // would resolve it — an allowlist of "which operand is the path" is the thing that goes stale, and
  // the others (a subcommand verb, a URL, a start-point ref) sit under the cwd and pass anyway.
  if (subcommand === 'clone' || subcommand === 'worktree') {
    for (const argument of rest) {
      if (argument.startsWith('-')) continue
      assertInsideRoot(deps.workspaceRoot, cwd, argument)
    }
  }
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
        // Boundary worth stating: env is a TRUSTED input here and argv filtering does not close
        // it — GIT_SSH_COMMAND, or GIT_CONFIG_COUNT pairs naming an executable setting, still
        // reach execution. It cannot simply be filtered, because those same mechanisms are how
        // the daemon delivers credential helpers and pins hooksPath; making it untrusted means
        // moving that policy into the shim, which is a design change, not a patch.
        ...(parsed.env ? { env: parsed.env } : {}),
        timeout: timeoutMs,
        // The daemon's abort kills the child here, matching what simple-git's signal does locally.
        ...(abort ? { signal: abort } : {}),
        // A killed git leaves index.lock behind, so the timeout is a last resort rather than
        // the primary cancellation path — the daemon aborting its request is.
        killSignal: 'SIGTERM',
        maxBuffer: MAX_STREAM_BYTES
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; signal?: string | null; killed?: boolean }) | null
        if (failure?.code === 'ABORT_ERR') {
          // A cancelled child reports neither killed nor a signal, so it must be classified before
          // the checks below or it reads as a spawn failure.
          reject(new ExecRefusedError(`git ${subcommand} was cancelled`))
          return
        }
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
        const deliver = (result: GitExecResult): void => {
          // Measured on the encoded form, since that is what the transport frames.
          const serialized = Buffer.byteLength(JSON.stringify(result), 'utf8')
          if (serialized > MAX_RESPONSE_BYTES) {
            reject(
              new ExecRefusedError(
                `git ${subcommand} result is ${serialized} bytes once encoded, over the ${MAX_RESPONSE_BYTES} a shim frame can carry`
              )
            )
            return
          }
          resolvePromise(result)
        }
        if (failure && (failure.killed === true || typeof failure.signal === 'string')) {
          // A signalled child has NO exit code — Node reports `code: null`, `signal: SIGTERM`.
          // Mapping that to 0 was the dangerous case: a timed-out `status` came back as success
          // with partial output, which every caller reads as a clean tree, and a timed-out
          // `rev-parse` as an empty HEAD. Non-zero makes it a failure the daemon raises.
          const signal = failure.signal ?? ''
          deliver({
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
        deliver({
          code: typeof failure?.code === 'number' ? failure.code : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })
}
