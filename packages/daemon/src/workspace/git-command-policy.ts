// Share the daemon's workspace Git command inventory across sandbox transports.
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'check-ref-format',
  'checkout',
  'clean',
  'clone',
  'commit',
  'config',
  'diff',
  'fetch',
  'fsck',
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

// Long options that reach execution or arbitrary reads; `--exec` is the hidden ls-remote/push alias of the pack programs.
const REFUSED_LONG_OPTIONS = [
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--exec-path',
  '--config',
  '--config-env',
  '--bundle-uri'
]

// Ad-hoc config in any short spelling: -c k=v, -ck=v.
const REFUSED_SHORT_CONFIG = /^-c/

// Exec-channel policy, not execution: admitted only for the workspace sync's `checkout --no-track -B <branch> <ref>`.
const REFUSED_CHECKOUT_ARGUMENT = [
  /^-f$/,
  /^--force$/,
  /^--$/,
  /^-m$/,
  /^--merge$/,
  /^-p$/,
  /^--patch$/,
  /^--ours$/,
  /^--theirs$/,
  /^--orphan/,
  /^--detach$/
]

// These spellings reach execution only for the named subcommand.
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  clone: [/^-u/],
  config: [/^-e$/, /^--edit/]
}

// Clone's short options: `u`/`c` execute anywhere in a group (`-qu<cmd>`), and a value-taking letter ends the group.
const CLONE_REFUSED_SHORT = new Set(['u', 'c'])
const CLONE_VALUE_SHORT = new Set(['o', 'b', 'j'])

// `--no-dangling` keeps a bundle's unreachable history from overflowing a shim frame.
const ADMITTED_FSCK = [['--connectivity-only'], ['--connectivity-only', '--no-dangling']]

const BUNDLE_URI_PREFIX = '--bundle-uri=https://'
const MAX_BUNDLE_URI_LENGTH = 8192
const BRANCH_REF_PREFIX = 'refs/heads/'
const MAX_REF_LENGTH = 1024

export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecRefusedError'
  }
}

// Git runs any unique prefix of a long option as the full option, so a prefix of a refused name is refused too.
function refusedLongOption(argument: string): string | undefined {
  if (!argument.startsWith('--')) return undefined
  const equals = argument.indexOf('=')
  const name = equals === -1 ? argument : argument.slice(0, equals)
  if (name.length <= 2) return undefined
  return REFUSED_LONG_OPTIONS.find((refused) => refused.startsWith(name) || name.startsWith(refused))
}

function refusedCloneShortGroup(argument: string): boolean {
  if (!argument.startsWith('-') || argument.startsWith('--')) return false
  for (const letter of argument.slice(1)) {
    if (CLONE_REFUSED_SHORT.has(letter)) return true
    if (CLONE_VALUE_SHORT.has(letter)) return false
  }
  return false
}

// Admit at most one `--bundle-uri=https://<host>/…` in exactly that spelling; returns its index or -1.
function validateBundleUri(rest: string[]): number {
  const occurrences = rest.flatMap((argument, index) => (refusedLongOption(argument) === '--bundle-uri' ? [index] : []))
  if (occurrences.length === 0) return -1
  if (occurrences.length > 1) throw new ExecRefusedError('--bundle-uri may be given at most once')
  const index = occurrences[0]!
  const argument = rest[index]!
  if (!argument.startsWith(BUNDLE_URI_PREFIX)) {
    throw new ExecRefusedError('--bundle-uri is admitted only as --bundle-uri=https://…')
  }
  const problem = bundleUriProblem(argument.slice('--bundle-uri='.length))
  if (problem) throw new ExecRefusedError(`--bundle-uri ${problem}`)
  return index
}

// Why a `--bundle-uri` value is refused, or undefined when it is admitted; shared by the exec rule and the skill plan schema.
export function bundleUriProblem(value: string): string | undefined {
  if (!value.startsWith('https://')) return 'must be an https URL'
  if (value.length > MAX_BUNDLE_URI_LENGTH) return 'value is too long'
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return 'value contains a forbidden character'
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0] ?? ''
  if (authority === '' || authority.includes('@')) return 'must name a host and carry no userinfo'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'value is not a URL'
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
    return 'must be an https URL with a host and no userinfo'
  }
  return undefined
}

// Git's ref-format rules (git check-ref-format), restricted to a full `refs/heads/*` name.
export function isValidBranchRef(ref: string): boolean {
  return isValidFullRef(ref, BRANCH_REF_PREFIX)
}

// Git's ref-format rules (git check-ref-format) for a full ref under `prefix`.
export function isValidFullRef(ref: string, prefix: string): boolean {
  if (ref.length > MAX_REF_LENGTH || !ref.startsWith(prefix)) return false
  if (ref.length === prefix.length || ref === '@') return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false
  if (ref.endsWith('/') || ref.endsWith('.')) return false
  return ref.split('/').every((component) => !component.startsWith('.') && !component.endsWith('.lock'))
}

export function validateGitArgs(args: string[]): void {
  const [subcommand, ...rest] = args
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new ExecRefusedError(`git ${subcommand ?? '(none)'} is not in the permitted inventory`)
  }
  assertNoRefusedArguments(args)
  if (subcommand !== 'checkout') return
  for (const argument of rest) {
    if (REFUSED_CHECKOUT_ARGUMENT.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused for git ${subcommand}`)
    }
  }
}

/** The execution-reaching refusals alone, without the exec inventory: what shim-internal Git argv is checked against. */
export function assertNoRefusedArguments(args: string[]): void {
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand.startsWith('-')) throw new ExecRefusedError('git argv must start with a subcommand')
  const bundleUri = subcommand === 'clone' ? validateBundleUri(rest) : -1
  rest.forEach((argument, index) => {
    if (index === bundleUri) return
    if (REFUSED_SHORT_CONFIG.test(argument) || refusedLongOption(argument)) {
      throw new ExecRefusedError(`argument ${argument} is refused`)
    }
  })
  const perSubcommand = REFUSED_SUBCOMMAND_ARGUMENT[subcommand] ?? []
  for (const argument of rest) {
    if (perSubcommand.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused for git ${subcommand}`)
    }
    if (subcommand === 'clone' && refusedCloneShortGroup(argument)) {
      throw new ExecRefusedError(`argument ${argument} is refused for git clone`)
    }
  }
  if (
    subcommand === 'fsck' &&
    !ADMITTED_FSCK.some(
      (form) => form.length === rest.length && form.every((argument, index) => argument === rest[index])
    )
  ) {
    throw new ExecRefusedError('git fsck is admitted only as fsck --connectivity-only [--no-dangling]')
  }
}
