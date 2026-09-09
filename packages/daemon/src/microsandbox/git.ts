import { posix } from 'node:path'
import { CommandGitRunner, GitExecPayloadSchema } from '../workspace/command-git-runner.js'
import { validateGitArgs } from '../workspace/git-command-policy.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'
import type { MicrosandboxExecute } from './exec.js'

const MAX_STREAM_BYTES = 64 * 1024

// Check physical guest paths before replacing the shell with Git; argv never becomes shell source.
const GIT_SCRIPT = `
set -eu
refuse() { printf 'microsandbox git refused: %s\\n' "$1" >&2; exit 126; }
cwd=$(pwd -P && printf '.')
cwd=\${cwd%??}
root=$(CDPATH= cd -P -- "$1" && pwd -P && printf '.') || refuse 'cwd does not resolve'
root=\${root%??}
shift
inside() { case "$1/" in "$root/"*) ;; *) refuse "$2";; esac; }
inside "$cwd" 'cwd escapes the workspace root'
case "$1" in
  clone|worktree)
    for argument do
      case "$argument" in -*) continue;; /*) path=$argument;; *) path=$cwd/$argument;; esac
      normalized=
      while [ -n "$path" ]; do
        part=\${path%%/*}
        case "$path" in */*) path=\${path#*/};; *) path=;; esac
        case "$part" in ''|.) ;; ..) normalized=\${normalized%/*};; *) normalized=$normalized/$part;; esac
      done
      inside "$normalized" 'path escapes the workspace root'
    done;;
esac
exec /usr/bin/git "$@"
`

export function microsandboxGitRunner(options: {
  execute: MicrosandboxExecute
  workspaceRoot: string
  cwd?: string
  env?: Record<string, string>
  mapEnv?: (env: Record<string, string>) => Record<string, string>
  abort?: AbortSignal
}): GitRunner {
  return new CommandGitRunner(
    async (payload) => {
      const parsed = GitExecPayloadSchema.parse(payload)
      const cwd = parsed.cwd ?? options.workspaceRoot
      try {
        validateGitArgs(parsed.args)
        if (!posix.isAbsolute(cwd) || !posix.isAbsolute(options.workspaceRoot)) throw new Error('cwd must be absolute')
      } catch (error) {
        throw new GitTransportError(error instanceof Error ? error.message : String(error), error)
      }
      const env = parsed.env === undefined ? undefined : (options.mapEnv?.({ ...parsed.env }) ?? parsed.env)
      let result
      try {
        result = await options.execute('/bin/sh', ['-c', GIT_SCRIPT, 'git', options.workspaceRoot, ...parsed.args], {
          cwd,
          ...(env !== undefined ? { env, inheritEnv: false } : {}),
          abort: options.abort,
          timeoutMs: parsed.timeoutMs,
          maxBytes: 2 * MAX_STREAM_BYTES
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'microsandbox exec output limit exceeded') {
          throw new Error(`git produced more than ${MAX_STREAM_BYTES} bytes on one stream`)
        }
        throw new GitTransportError(error instanceof Error ? error.message : String(error), error)
      }
      if (result.exitCode === 126 && /^microsandbox git refused:/m.test(result.stderr)) {
        throw new GitTransportError(result.stderr.trim())
      }
      if ([result.stdout, result.stderr].some((stream) => Buffer.byteLength(stream) > MAX_STREAM_BYTES)) {
        throw new Error(`git produced more than ${MAX_STREAM_BYTES} bytes on one stream`)
      }
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
    options.cwd,
    options.env
  )
}
