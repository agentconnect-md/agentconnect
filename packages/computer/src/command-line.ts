// The command-line tier (computer-use.md §5.7): commands and files on this machine, as the signed-in person, never the driver's.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  COMPUTER_EXEC_OUTPUT_TAIL_BYTES,
  COMPUTER_EXEC_PER_SESSION_MAX,
  COMPUTER_EXEC_TIMEOUT_DEFAULT_MS,
  COMPUTER_EXEC_TIMEOUT_MAX_MS,
  COMPUTER_EXEC_TOTAL_MAX,
  COMPUTER_LIST_DIR_MAX,
  COMPUTER_READ_IMAGE_MAX_BYTES,
  COMPUTER_READ_TEXT_MAX_BYTES,
  COMPUTER_WRITE_MAX_BYTES,
  narrowerFiles,
  narrowerShell,
  type ComputerFilesMode,
  type ComputerPolicy,
  type ComputerShellMode
} from '@agentconnect.md/protocol/computer'
import type { AuditSink } from './audit.js'
import type { ToolOutput } from './computer.js'

export type CommandLineErrorCode =
  | 'invalid_argument'
  | 'path_refused'
  | 'not_found'
  | 'binary_file'
  | 'too_large'
  | 'exec_busy'
  | 'timeout'
  | 'human_in_control'
  | 'unavailable'
  | 'approval_required'
  | 'failed'

export class CommandLineError extends Error {
  constructor(
    readonly code: CommandLineErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'CommandLineError'
  }
}

export interface CommandLineDeps {
  audit?: AuditSink
  /** Why the Control Plane's authority is missing; every call is refused while it is. */
  refusal?: () => string | undefined
  /** Why the owner stopped agents (a pause or a console Stop, not a viewer takeover); every call is refused while set. */
  halted?: () => string | undefined
  /** The desktop daemon's data directory, which the file tools always refuse (§5.7). */
  dataDir: string
  now?: () => number
  log?: (line: string) => void
  /** The shell commands run in; defaults to the account's login shell. */
  shell?: string
  home?: string
  env?: NodeJS.ProcessEnv
}

/** A token's tier narrowed by the policy the CP pushed since; that policy names the tier resolved, so an unset field reads off. */
export function narrowedCommandLine(
  granted: { shell: ComputerShellMode; files: ComputerFilesMode },
  policy: Pick<ComputerPolicy, 'agentMode' | 'shell' | 'files'> | undefined
): { shell: ComputerShellMode; files: ComputerFilesMode } {
  if (!policy) return granted
  return {
    shell: policy.agentMode === 'view' ? 'off' : narrowerShell(granted.shell, policy.shell ?? 'off'),
    files: narrowerFiles(granted.files, policy.files ?? 'off')
  }
}

/** Whether this platform runs the tier (§5.7): Linux only until Windows runs commands as the user and macOS sheds its TCC grants. */
export const commandLineSupported = (platform: NodeJS.Platform = process.platform): boolean => platform === 'linux'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const BINARY_SNIFF_BYTES = 8192

/** The account's login shell from the account database, else `/bin/sh`. */
export function loginShell(): string {
  try {
    const shell = userInfo().shell
    if (shell && isAbsolute(shell)) return shell
  } catch {
    // An account without a passwd entry (a bare container uid) falls back.
  }
  return '/bin/sh'
}

/** The environment a command gets: the session's, without the daemon's own settings or secrets. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('AGENTCONNECT_')) out[key] = value
  return out
}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

// The real path of `path`, or of its nearest existing ancestor with the rest appended, so a new file resolves too.
async function realOrPlanned(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) return path
    return join(await realOrPlanned(parent), basename(path))
  }
}

/** One bounded tail of a stream: the last `max` bytes, and how many came in all. */
class Tail {
  private chunks: Buffer[] = []
  private kept = 0
  total = 0

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.kept += chunk.length
    while (this.kept - (this.chunks[0]?.length ?? 0) >= this.max) this.kept -= this.chunks.shift()!.length
  }

  text(): string {
    const all = Buffer.concat(this.chunks)
    return all.subarray(Math.max(0, all.length - this.max)).toString('utf8')
  }

  get truncated(): boolean {
    return this.total > this.max
  }
}

interface Running {
  client: string
  child: ChildProcess
}

/** Runs the tier's calls for every caller: the fence, the limits, and the kill path when the owner stops agents. */
export class CommandLine {
  private readonly running = new Set<Running>()
  private readonly audit: AuditSink
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly home: string
  private readonly shell: string
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly deps: CommandLineDeps) {
    this.audit = deps.audit ?? (() => undefined)
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => undefined)
    this.home = deps.home ?? homedir()
    this.shell = deps.shell ?? loginShell()
    this.env = commandEnv(deps.env ?? process.env)
  }

  /** The shell `computer_list` reports. */
  shellName(): string {
    return basename(this.shell)
  }

  /** How many commands run now, for the local indicator. */
  runningCount(): number {
    return this.running.size
  }

  /** Kill every running command's process group: the owner stopped agents, or the authority went away. */
  halt(reason: string): void {
    if (this.running.size === 0) return
    this.log(`stopping ${this.running.size} running command(s): ${reason}`)
    for (const run of this.running) killGroup(run.child)
  }

  private assertMayRun(): void {
    const refusal = this.deps.refusal?.()
    if (refusal) throw new CommandLineError('unavailable', refusal)
    const halted = this.deps.halted?.()
    if (halted) throw new CommandLineError('human_in_control', `the owner stopped agents: ${halted}`)
  }

  // ---- computer_exec ----

  exec(
    client: string,
    args: { command: string; cwd?: string; timeoutMs?: number },
    signal?: AbortSignal
  ): Promise<ToolOutput> {
    return this.audited(client, 'computer_exec', args, async (record) => {
      const timeoutMs = Math.min(args.timeoutMs ?? COMPUTER_EXEC_TIMEOUT_DEFAULT_MS, COMPUTER_EXEC_TIMEOUT_MAX_MS)
      const cwd = await this.directory(args.cwd)
      const mine = [...this.running].filter((run) => run.client === client).length
      if (mine >= COMPUTER_EXEC_PER_SESSION_MAX || this.running.size >= COMPUTER_EXEC_TOTAL_MAX)
        throw new CommandLineError('exec_busy', 'too many commands are running on this computer; wait for one to end')
      const started = this.now()
      const child = spawn(this.shell, ['-c', args.command], {
        cwd,
        env: this.env,
        // Its own process group, so a kill reaches everything the command started.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const run: Running = { client, child }
      this.running.add(run)
      const stdout = new Tail(COMPUTER_EXEC_OUTPUT_TAIL_BYTES)
      const stderr = new Tail(COMPUTER_EXEC_OUTPUT_TAIL_BYTES)
      child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killGroup(child)
      }, timeoutMs)
      const abort = () => killGroup(child)
      signal?.addEventListener('abort', abort, { once: true })
      const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((done) => {
        child.once('error', (error) => done({ code: null, signal: null, error }))
        child.once('close', (code, sig) => done({ code, signal: sig }))
      }).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        // Whatever the command left running in its group ends with it, so nothing outlives the call, a Stop or the cap.
        killGroup(child)
        this.running.delete(run)
      })
      if (ended.error) throw new CommandLineError('failed', `the command could not start: ${ended.error.message}`)
      const halted = this.deps.halted?.() ?? this.deps.refusal?.()
      const result = {
        exitCode: ended.code,
        signal: ended.signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
        durationMs: this.now() - started,
        ...(timedOut ? { timedOut: true } : {})
      }
      record.exitCode = ended.code
      record.outputBytes = stdout.total + stderr.total
      if (timedOut) return error('timeout', `the command ran past ${timeoutMs} ms and was killed`, result)
      if (halted && ended.signal) return error('human_in_control', `the command was killed: ${halted}`, result)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  }

  private async directory(cwd: string | undefined): Promise<string> {
    const path = cwd === undefined ? this.home : this.expand(cwd)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isDirectory()) throw new CommandLineError('not_found', `no such directory: ${cwd}`)
    return path
  }

  // ---- the file tools ----

  readFile(client: string, args: { path: string; offset?: number; limit?: number }, roots?: string[]) {
    return this.audited(client, 'computer_read_file', args, async (record) => {
      const path = await this.fenced(args.path, roots)
      const info = await stat(path).catch(() => undefined)
      if (!info) throw new CommandLineError('not_found', `no such file: ${args.path}`)
      if (!info.isFile()) throw new CommandLineError('invalid_argument', `not a regular file: ${args.path}`)
      record.bytes = info.size
      const image = IMAGE_TYPES[extname(path).toLowerCase()]
      if (image) {
        if (info.size > COMPUTER_READ_IMAGE_MAX_BYTES)
          throw new CommandLineError('too_large', `images are read up to ${COMPUTER_READ_IMAGE_MAX_BYTES} bytes`)
        const bytes = await readBounded(path, COMPUTER_READ_IMAGE_MAX_BYTES)
        return {
          content: [
            { type: 'image', data: bytes.toString('base64'), mimeType: image },
            { type: 'text', text: JSON.stringify({ path, bytes: info.size }) }
          ]
        }
      }
      const bytes = await readBounded(path, COMPUTER_READ_TEXT_MAX_BYTES + 1)
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))
        throw new CommandLineError('binary_file', `${args.path} is a binary file`)
      const truncatedBytes = bytes.length > COMPUTER_READ_TEXT_MAX_BYTES
      const lines = bytes.subarray(0, COMPUTER_READ_TEXT_MAX_BYTES).toString('utf8').split('\n')
      // A file cut at the byte cap ends in a partial line, which is not returned.
      if (truncatedBytes) lines.pop()
      const from = Math.max(1, args.offset ?? 1)
      const slice = lines.slice(from - 1, args.limit === undefined ? undefined : from - 1 + args.limit)
      const truncated = truncatedBytes || from - 1 + slice.length < lines.length
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path,
              bytes: info.size,
              fromLine: from,
              lines: slice.length,
              truncated,
              content: slice.join('\n')
            })
          }
        ]
      }
    })
  }

  listDir(client: string, args: { path: string }, roots?: string[]) {
    return this.audited(client, 'computer_list_dir', args, async () => {
      const path = await this.fenced(args.path, roots)
      const info = await stat(path).catch(() => undefined)
      if (!info) throw new CommandLineError('not_found', `no such directory: ${args.path}`)
      if (!info.isDirectory()) throw new CommandLineError('invalid_argument', `not a directory: ${args.path}`)
      const names = (await readdir(path)).sort()
      const entries = await Promise.all(
        names.slice(0, COMPUTER_LIST_DIR_MAX).map(async (name) => {
          const entry = await lstat(join(path, name)).catch(() => undefined)
          const type = !entry
            ? 'unknown'
            : entry.isSymbolicLink()
              ? 'symlink'
              : entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                  ? 'file'
                  : 'other'
          return {
            name,
            type,
            ...(entry ? { size: entry.size, mtime: entry.mtime.toISOString() } : {})
          }
        })
      )
      const result = { path, entries, ...(names.length > COMPUTER_LIST_DIR_MAX ? { truncated: names.length } : {}) }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  }

  writeFile(client: string, args: { path: string; content: string }, roots?: string[]) {
    return this.audited(client, 'computer_write_file', args, async (record) => {
      const bytes = Buffer.from(args.content, 'utf8')
      if (bytes.length > COMPUTER_WRITE_MAX_BYTES)
        throw new CommandLineError('too_large', `a write is limited to ${COMPUTER_WRITE_MAX_BYTES} bytes`)
      const path = await this.fenced(args.path, roots)
      const parent = await stat(dirname(path)).catch(() => undefined)
      if (!parent?.isDirectory()) throw new CommandLineError('not_found', `no such directory: ${dirname(args.path)}`)
      const existing = await stat(path).catch(() => undefined)
      if (existing && !existing.isFile())
        throw new CommandLineError('invalid_argument', `not a regular file: ${args.path}`)
      // Staged beside the target, then renamed over it, so a reader never sees half a file.
      const staged = join(dirname(path), `.${basename(path)}.agentconnect-${randomBytes(6).toString('hex')}`)
      try {
        const handle = await open(
          staged,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          existing ? existing.mode & 0o777 : 0o644
        )
        try {
          await handle.writeFile(bytes)
        } finally {
          await handle.close()
        }
        await rename(staged, path)
      } catch (cause) {
        await rm(staged, { force: true }).catch(() => undefined)
        throw cause
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      record.bytes = bytes.length
      record.sha256 = sha256
      return { content: [{ type: 'text', text: JSON.stringify({ path, bytes: bytes.length, sha256 }) }] }
    })
  }

  private expand(path: string): string {
    if (path === '~') return this.home
    if (path.startsWith('~/')) return join(this.home, path.slice(2))
    if (!isAbsolute(path)) throw new CommandLineError('invalid_argument', `expected an absolute path: ${path}`)
    return resolve(path)
  }

  /** The fence (§5.7): an absolute path, resolved through symlinks, inside a root and outside the data directory. */
  async fenced(path: string, roots: readonly string[] | undefined): Promise<string> {
    if (path.includes('\u0000')) throw new CommandLineError('invalid_argument', 'a path cannot hold NUL')
    const real = await realOrPlanned(this.expand(path))
    const data = await realOrPlanned(resolve(this.deps.dataDir))
    if (within(real, data))
      throw new CommandLineError('path_refused', "the computer daemon's own data directory is out of reach")
    const allowed = await Promise.all((roots?.length ? roots : ['~']).map((root) => realOrPlanned(this.expand(root))))
    if (!allowed.some((root) => within(real, root)))
      throw new CommandLineError('path_refused', `${path} is outside the paths this computer allows`, {
        roots: roots?.length ? roots : ['~']
      })
    return real
  }

  private async audited(
    client: string,
    tool: string,
    args: Record<string, unknown>,
    fn: (record: Record<string, unknown>) => Promise<ToolOutput>
  ): Promise<ToolOutput> {
    const started = this.now()
    const record: Record<string, unknown> = {}
    try {
      this.assertMayRun()
      const output = await fn(record)
      this.audit({
        client,
        tool,
        args: { ...args, ...record },
        outcome: output.isError ? 'error' : 'ok',
        ...(output.isError ? { code: codeOf(output) } : {}),
        ms: this.now() - started
      })
      return output
    } catch (cause) {
      const failure =
        cause instanceof CommandLineError
          ? cause
          : new CommandLineError('failed', (cause as Error)?.message ?? String(cause))
      this.audit({
        client,
        tool,
        args: { ...args, ...record },
        outcome: 'error',
        code: failure.code,
        ms: this.now() - started
      })
      return error(failure.code, failure.message, failure.details)
    }
  }
}

const codeOf = (output: ToolOutput): string => {
  try {
    return (JSON.parse(output.content[0]?.text ?? '{}') as { error?: string }).error || 'failed'
  } catch {
    return 'failed'
  }
}

const error = (code: string, message: string, details: Record<string, unknown> = {}): ToolOutput => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...details }) }]
})

// The group outlives its shell while a background child holds on, so the kill never checks the leader's exit.
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH: the whole group is gone already.
  }
}

async function readBounded(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(max)
    let length = 0
    while (length < max) {
      const { bytesRead } = await handle.read(buffer, length, max - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}
