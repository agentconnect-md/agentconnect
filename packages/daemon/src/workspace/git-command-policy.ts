import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'

// Share the daemon's workspace Git command inventory across sandbox transports.
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'bundle',
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

// These spellings reach execution only for the named subcommand.
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  // Admitted only for the workspace sync's `checkout --no-track -B <branch> <ref>`; every form that discards or restores files stays out.
  checkout: [
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
  ],
  clone: [/^-u/],
  config: [/^-e$/, /^--edit/]
}

// Clone's short options: `u`/`c` execute anywhere in a group (`-qu<cmd>`), and a value-taking letter ends the group.
const CLONE_REFUSED_SHORT = new Set(['u', 'c'])
const CLONE_VALUE_SHORT = new Set(['o', 'b', 'j'])

const BUNDLE_URI_PREFIX = '--bundle-uri=https://'
const MAX_BUNDLE_URI_LENGTH = 8192
const BUNDLE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.bundle$/
const BRANCH_REF_PREFIX = 'refs/heads/'
const MAX_REF_LENGTH = 1024

export interface GitPolicyContext {
  // The shim's bundle staging directory; without one `bundle` is refused.
  bundleStagingDir?: string
}

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
  const value = argument.slice('--bundle-uri='.length)
  if (value.length > MAX_BUNDLE_URI_LENGTH) throw new ExecRefusedError('--bundle-uri value is too long')
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) {
    throw new ExecRefusedError('--bundle-uri value contains a forbidden character')
  }
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0] ?? ''
  if (authority === '' || authority.includes('@')) {
    throw new ExecRefusedError('--bundle-uri must name a host and carry no userinfo')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ExecRefusedError('--bundle-uri value is not a URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
    throw new ExecRefusedError('--bundle-uri must be an https URL with a host and no userinfo')
  }
  return index
}

// Git's ref-format rules (git check-ref-format), restricted to a full `refs/heads/*` name.
export function isValidBranchRef(ref: string): boolean {
  if (ref.length > MAX_REF_LENGTH || !ref.startsWith(BRANCH_REF_PREFIX)) return false
  if (ref.length === BRANCH_REF_PREFIX.length || ref === '@') return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false
  if (ref.endsWith('/') || ref.endsWith('.')) return false
  return ref.split('/').every((component) => !component.startsWith('.') && !component.endsWith('.lock'))
}

// Admit only `bundle create [-q] <file> [--filter=blob:none] refs/heads/<name>` with <file> a direct child of the staging dir.
function validateBundleCreate(rest: string[], stagingDir: string | undefined): void {
  if (!stagingDir) throw new ExecRefusedError('git bundle is refused: this shim has no bundle staging directory')
  const [verb, ...operands] = rest
  if (verb !== 'create') throw new ExecRefusedError(`git bundle ${verb ?? '(none)'} is refused`)
  const quiet = operands[0] === '-q' ? 1 : 0
  const tail = operands.slice(quiet)
  const filtered = tail.length === 3 && tail[1] === '--filter=blob:none'
  if (tail.length !== (filtered ? 3 : 2)) throw new ExecRefusedError('git bundle create has an unexpected shape')
  const file = tail[0]!
  const ref = tail[tail.length - 1]!
  if (!isAbsolute(file) || normalize(file) !== file || dirname(file) !== resolve(stagingDir)) {
    throw new ExecRefusedError(`bundle file must be directly inside the staging directory: ${file}`)
  }
  if (!BUNDLE_FILE_NAME.test(basename(file))) throw new ExecRefusedError(`bundle file name is refused: ${file}`)
  if (!isValidBranchRef(ref)) throw new ExecRefusedError(`bundle ref must be a full refs/heads/* name: ${ref}`)
}

// The <file> operand of an already-validated `bundle create`.
export function bundleCreateFile(args: string[]): string {
  const operands = args.slice(2)
  return operands[0] === '-q' ? operands[1]! : operands[0]!
}

export function validateGitArgs(args: string[], context: GitPolicyContext = {}): void {
  const [subcommand, ...rest] = args
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new ExecRefusedError(`git ${subcommand ?? '(none)'} is not in the permitted inventory`)
  }
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
  if (subcommand === 'bundle') validateBundleCreate(rest, context.bundleStagingDir)
  if (subcommand === 'fsck' && (rest.length !== 1 || rest[0] !== '--connectivity-only')) {
    throw new ExecRefusedError('git fsck is admitted only as fsck --connectivity-only')
  }
}
