import { posix } from 'node:path'
import type { WorkspaceFs } from '../workspace/workspace-fs.js'
import type { MicrosandboxExecute } from './exec.js'

// Keep directory descriptors open through each mutation so workspace renames cannot redirect it.
const MUTATE = String.raw`
import contextlib, errno, json, os, secrets, shutil, signal, stat, sys

request = json.loads(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def interrupted(signum, frame):
    raise InterruptedError('workspace mutation interrupted')

signal.signal(signal.SIGTERM, interrupted)

def removal_error(function, path, error):
    if not isinstance(error[1], FileNotFoundError):
        raise error[1]

with contextlib.ExitStack() as stack:
    def hold(fd):
        stack.callback(os.close, fd)
        return fd

    root = hold(os.open(request['root'], flags))

    def descend(parts, create=False, mode=0o777):
        fd = root
        for part in parts:
            if part in ('', '.', '..') or '/' in part or '\0' in part:
                raise ValueError('invalid workspace path component')
            try:
                child = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, mode, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, flags, dir_fd=fd)
            fd = hold(child)
        return fd

    def parent(parts, create=False):
        if not parts or parts[-1] in ('', '.', '..') or '/' in parts[-1] or '\0' in parts[-1]:
            raise ValueError('a workspace leaf is required')
        return descend(parts[:-1], create), parts[-1]

    op = request['op']
    parts = request['paths'][0]
    result = None
    try:
        if op == 'mkdir':
            descend(parts, True, request.get('mode', 0o777))
        elif op == 'writeFile':
            fd, leaf = parent(parts, True)
            try:
                if not stat.S_ISREG(os.stat(leaf, dir_fd=fd, follow_symlinks=False).st_mode):
                    raise ValueError('workspace target is not a regular file')
            except FileNotFoundError:
                pass
            temporary = '.agentconnect-write-' + secrets.token_hex(16) + '.tmp'
            opened = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             request.get('mode', 0o644), dir_fd=fd)
            try:
                with os.fdopen(opened, 'wb') as output:
                    shutil.copyfileobj(sys.stdin.buffer, output, 65536)
                    if output.tell() != request['expectedBytes']:
                        raise ValueError('incomplete workspace file content')
                os.replace(temporary, leaf, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
        elif op == 'rename':
            source, leaf = parent(parts)
            os.stat(leaf, dir_fd=source, follow_symlinks=False)
            target, name = parent(request['paths'][1], True)
            os.rename(leaf, name, src_dir_fd=source, dst_dir_fd=target)
        elif op == 'rmdir':
            fd, leaf = parent(parts)
            try:
                os.rmdir(leaf, dir_fd=fd)
                result = True
            except OSError as error:
                if error.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                    raise
                result = False
        elif op == 'rmTree':
            fd, leaf = parent(parts)
            if stat.S_ISDIR(os.stat(leaf, dir_fd=fd, follow_symlinks=False).st_mode):
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise RuntimeError('safe recursive removal is unavailable')
                shutil.rmtree(leaf, dir_fd=fd, onerror=removal_error)
            else:
                os.unlink(leaf, dir_fd=fd)
        else:
            raise ValueError('unsupported workspace mutation')
    except FileNotFoundError:
        if op not in ('rmdir', 'rmTree'):
            raise
        result = True if op == 'rmdir' else None
    print(json.dumps(result))
`

type WorkspaceMutations = Pick<WorkspaceFs, 'mkdir' | 'writeFile' | 'rename' | 'rmdir' | 'rmTree'>

export function createMicrosandboxWorkspaceMutations(options: {
  workspaceRoot: string
  execute: MicrosandboxExecute
}): WorkspaceMutations {
  const root = options.workspaceRoot
  if (!posix.isAbsolute(root) || root.includes('\0')) throw new Error('workspace root must be absolute')
  const segments = (path: string): string[] => {
    const rel = posix.relative(root, path)
    if (!posix.isAbsolute(path) || path.includes('\0') || rel === '..' || rel.startsWith('../')) {
      throw new Error('workspace path is outside the sandbox mount')
    }
    return rel === '' ? [] : rel.split('/')
  }
  const run = async (
    op: keyof WorkspaceMutations,
    paths: string[],
    mode?: number,
    stdin?: string
  ): Promise<unknown> => {
    const request = {
      root,
      op,
      paths: paths.map(segments),
      ...(mode === undefined ? {} : { mode }),
      ...(stdin === undefined ? {} : { expectedBytes: Buffer.byteLength(stdin, 'utf8') })
    }
    const result = await options.execute('/usr/bin/python3', ['-I', '-c', MUTATE, JSON.stringify(request)], {
      timeoutMs: 30_000,
      maxBytes: 4096,
      ...(stdin === undefined ? {} : { stdin })
    })
    if (result.exitCode !== 0) throw new Error(`workspace ${op} failed: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout)
  }
  return {
    mkdir: async (path, mode) => void (await run('mkdir', [path], mode)),
    writeFile: async (path, content, opts) => void (await run('writeFile', [path], opts?.mode, content)),
    rename: async (from, to) => void (await run('rename', [from, to])),
    rmdir: async (path) => {
      const removed = await run('rmdir', [path])
      if (typeof removed !== 'boolean') throw new Error('workspace rmdir returned an invalid result')
      return removed
    },
    rmTree: async (path) => void (await run('rmTree', [path]))
  }
}
