// A Computer's command-line tier (computer-use.md §5.7): computer_exec and the file tools, granted apart from the GUI ones.
import { z } from 'zod'

/** `computer_exec`: never, after a person allows each command, or always. */
export const COMPUTER_SHELL_MODES = ['off', 'ask', 'on'] as const
export type ComputerShellMode = (typeof COMPUTER_SHELL_MODES)[number]

/** The file tools: none, the reading ones, or reading and writing. */
export const COMPUTER_FILES_MODES = ['off', 'read', 'read-write'] as const
export type ComputerFilesMode = (typeof COMPUTER_FILES_MODES)[number]

/** The most prefixes a policy's `fileRoots` lists. */
export const COMPUTER_FILE_ROOTS_MAX = 32

/** An absolute path the file tools may touch: POSIX (`/…`), home-relative (`~/…`), or a Windows drive path. */
export const ComputerFileRoot = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((p) => /^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(p) && !p.includes('\u0000'), 'expected an absolute path')

/** The CP issues channel tokens naming the tier, and the agent daemon offers its tools only under such a CP. */
export const COMPUTER_COMMAND_LINE_FEATURE = 'computer-command-line-v1'

export const COMPUTER_EXEC_TIMEOUT_DEFAULT_MS = 30_000
/** Inside the relay's 120 s request timeout, with room for the agent daemon's own margin. */
export const COMPUTER_EXEC_TIMEOUT_MAX_MS = 90_000
export const COMPUTER_EXEC_COMMAND_MAX_CHARS = 16_384
/** stdout and stderr each keep their last this many bytes. */
export const COMPUTER_EXEC_OUTPUT_TAIL_BYTES = 32 * 1024
/** Commands one session, and the whole desktop, may run at once. */
export const COMPUTER_EXEC_PER_SESSION_MAX = 4
export const COMPUTER_EXEC_TOTAL_MAX = 8
export const COMPUTER_READ_TEXT_MAX_BYTES = 256 * 1024
export const COMPUTER_READ_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const COMPUTER_WRITE_MAX_BYTES = 1024 * 1024
export const COMPUTER_LIST_DIR_MAX = 1000

/** What a Computer's policy allows of the tier; absent fields take the Computer's defaults (§5.7). */
export interface ComputerCommandLinePolicy {
  agentMode: 'view' | 'control'
  shell?: ComputerShellMode | undefined
  files?: ComputerFilesMode | undefined
}

/** The tier in effect: on for a managed computer and off for a self-hosted one unless set; a `view` Computer has no shell. */
export function computerCommandLine(
  policy: ComputerCommandLinePolicy,
  computer: { kind: 'self-hosted' | 'managed' }
): { shell: ComputerShellMode; files: ComputerFilesMode } {
  const managed = computer.kind === 'managed'
  return {
    shell: policy.agentMode === 'view' ? 'off' : (policy.shell ?? (managed ? 'on' : 'off')),
    files: policy.files ?? (managed ? 'read-write' : 'off')
  }
}

const SHELL_RANK: Record<ComputerShellMode, number> = { off: 0, ask: 1, on: 2 }
const FILES_RANK: Record<ComputerFilesMode, number> = { off: 0, read: 1, 'read-write': 2 }

/** The narrower of two shell modes, so a token and a later policy push together allow only what both do. */
export const narrowerShell = (a: ComputerShellMode, b: ComputerShellMode): ComputerShellMode =>
  SHELL_RANK[a] <= SHELL_RANK[b] ? a : b

export const narrowerFiles = (a: ComputerFilesMode, b: ComputerFilesMode): ComputerFilesMode =>
  FILES_RANK[a] <= FILES_RANK[b] ? a : b
