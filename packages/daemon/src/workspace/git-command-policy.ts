// Share the daemon's workspace Git command inventory across sandbox transports.
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'check-ref-format',
  'clean',
  'clone',
  'commit',
  'config',
  'diff',
  'fetch',
  'log',
  'ls-files',
  'ls-remote',
  'pull',
  'push',
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

// Refuse execution options in every accepted spelling.
const REFUSED_ARGUMENT = [
  /^-c/, // ad-hoc config in any spelling: -c k=v, -ck=v
  /^--config/, // --config=k=v, --config-env=…
  /^--exec-path/, // relocates git's helper binaries
  /^--upload-pack/,
  /^--receive-pack/
]

// These spellings reach execution only for the named subcommand.
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  clone: [/^-u/],
  config: [/^-e$/, /^--edit/]
}

export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecRefusedError'
  }
}

export function validateGitArgs(args: string[]): void {
  const [subcommand, ...rest] = args
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new ExecRefusedError(`git ${subcommand ?? '(none)'} is not in the permitted inventory`)
  }
  const perSubcommand = REFUSED_SUBCOMMAND_ARGUMENT[subcommand] ?? []
  for (const argument of args) {
    if (REFUSED_ARGUMENT.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused`)
    }
  }
  for (const argument of rest) {
    if (perSubcommand.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused for git ${subcommand}`)
    }
  }
}
