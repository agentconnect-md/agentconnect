import { execFile } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MicrosandboxExecute } from '../src/microsandbox/exec.js'
import { createMicrosandboxWorkspaceMutations } from '../src/microsandbox/files.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const execute: MicrosandboxExecute = async (_command, args, options) =>
  await new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      args,
      { encoding: 'utf8', timeout: options?.timeoutMs, maxBuffer: options?.maxBytes },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(error)
        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
      }
    )
    child.stdin!.on('error', () => {})
    child.stdin!.end(options?.stdin)
  })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-microsandbox-files-')))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot)
  return { root, workspaceRoot, files: createMicrosandboxWorkspaceMutations({ workspaceRoot, execute }) }
}

describe.skipIf(process.platform === 'win32')('microsandbox native workspace mutations', () => {
  it('publishes large UTF-8 writes atomically with requested permissions and no staging leftovers', async () => {
    const { files, workspaceRoot } = fixture()
    const directory = join(workspaceRoot, 'nested', 'directory')
    await files.mkdir(directory, 0o700)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    const path = join(directory, 'marker')
    writeFileSync(path, 'previous')
    const previous = openSync(path, 'r')
    try {
      const content = '漢字🙂\n'.repeat(50_000)
      await files.writeFile(path, content, { mode: 0o600 })
      expect(readFileSync(path, 'utf8')).toBe(content)
      expect(readFileSync(previous, 'utf8')).toBe('previous')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(directory)).toEqual(['marker'])
      const missingParent = join(workspaceRoot, 'created-by-write', 'marker')
      await files.writeFile(missingParent, 'created', { mode: 0o600 })
      expect(readFileSync(missingParent, 'utf8')).toBe('created')
    } finally {
      closeSync(previous)
    }
  })

  it('renames directories and removes only empty directories until recursive removal is requested', async () => {
    const { files, workspaceRoot } = fixture()
    const source = join(workspaceRoot, 'source')
    const target = join(workspaceRoot, 'new-parent', 'target')
    await files.mkdir(source)
    await files.writeFile(join(source, 'marker'), 'kept')
    await files.rename(source, target)
    expect(existsSync(source)).toBe(false)
    expect(await files.rmdir(target)).toBe(false)
    expect(await files.rmdir(join(target, 'marker'))).toBe(false)
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('kept')
    const empty = join(target, 'empty')
    await files.mkdir(empty)
    expect(await files.rmdir(empty)).toBe(true)
    expect(await files.rmdir(empty)).toBe(true)
    await files.rmTree(target)
    await files.rmTree(target)
    await expect(files.rename(source, target)).rejects.toThrow('workspace rename failed')
  })

  it('keeps the previous file and removes staging when stdin closes before all content arrives', async () => {
    const { workspaceRoot } = fixture()
    const path = join(workspaceRoot, 'marker')
    writeFileSync(path, 'previous')
    const files = createMicrosandboxWorkspaceMutations({
      workspaceRoot,
      execute: (command, args, options) => execute(command, args, { ...options, stdin: 'partial' })
    })
    await expect(files.writeFile(path, 'partial content')).rejects.toThrow('incomplete workspace file content')
    expect(readFileSync(path, 'utf8')).toBe('previous')
    expect(readdirSync(workspaceRoot)).toEqual(['marker'])
  })

  it('rejects symlink parents and file targets while recursive removal unlinks a leaf symlink', async () => {
    const { files, root, workspaceRoot } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'marker'), 'untouched')
    const link = join(workspaceRoot, 'link')
    symlinkSync(outside, link, 'dir')
    await expect(files.mkdir(join(link, 'child'))).rejects.toThrow()
    await expect(files.writeFile(join(link, 'marker'), 'changed')).rejects.toThrow()
    await expect(files.rmTree(join(link, 'marker'))).rejects.toThrow()
    await expect(files.rename(join(link, 'marker'), join(workspaceRoot, 'moved'))).rejects.toThrow()
    const marker = join(workspaceRoot, 'marker')
    await files.writeFile(marker, 'local')
    await expect(files.rename(marker, join(link, 'moved'))).rejects.toThrow()
    const leaf = join(workspaceRoot, 'leaf')
    symlinkSync(join(outside, 'marker'), leaf)
    await expect(files.writeFile(leaf, 'changed')).rejects.toThrow()
    expect(await files.rmdir(link)).toBe(false)
    await files.rmTree(link)
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('untouched')
    expect(readdirSync(outside)).toEqual(['marker'])
  })

  it('refuses paths outside the mount and destructive operations on the mount itself', async () => {
    const { files, root, workspaceRoot } = fixture()
    await expect(files.writeFile(join(root, 'outside'), 'bad')).rejects.toThrow('outside the sandbox mount')
    await expect(files.mkdir('relative')).rejects.toThrow('outside the sandbox mount')
    await expect(files.rmTree(workspaceRoot)).rejects.toThrow('workspace rmTree failed')
    await expect(files.rmdir(workspaceRoot)).rejects.toThrow('workspace rmdir failed')
    expect(existsSync(workspaceRoot)).toBe(true)
  })
})
