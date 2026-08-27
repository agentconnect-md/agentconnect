import { afterAll, describe, expect, it } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalWorkspaceFs, type WorkspaceFs } from '../src/workspace/workspace-fs.js'
import { ShimWorkspaceFs } from '../src/shim/workspace-fs-channel.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import { pathExecutor, shimRequester } from './fixtures/memory-fs-pod.js'

/**
 * The two halves of the workspace-fs seam, held to ONE contract.
 *
 * That is the whole point of the seam: a cluster agent's worktree paths and a self-hosted one's run
 * the same code, and the only thing that differs is which filesystem answers. So the behaviours are
 * asserted against both implementations from one table — a divergence here is a divergence in what a
 * pool agent's session worktree does, which is exactly the class of bug the seam replaces.
 *
 * `stat` carries the most weight: it is what the local code expressed as `existsSync` plus an
 * `lstatSync().isSymbolicLink()` refusal, and collapsing those into one answer is what makes the
 * refusal portable.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wsfs-'))
  roots.push(dir)
  return dir
}

/** The same tree reached two ways: directly, and through the shim channel anchored at its mount. */
function subjects(): Array<{ name: string; fs: WorkspaceFs; root: string }> {
  const local = tempRoot()
  const mount = tempRoot()
  return [
    { name: 'LocalWorkspaceFs', fs: new LocalWorkspaceFs(), root: local },
    { name: 'ShimWorkspaceFs', fs: new ShimWorkspaceFs(shimRequester(mount, pathExecutor()), mount), root: mount }
  ]
}

for (const { name, fs, root } of subjects()) {
  describe(name, () => {
    it('answers what a path IS, and never follows a symlink to say it', async () => {
      const dir = join(root, 'stat')
      await fs.mkdir(dir)
      writeFileSync(join(dir, 'file.txt'), 'x')
      mkdirSync(join(dir, 'sub'))
      symlinkSync(join(dir, 'sub'), join(dir, 'link-to-dir'))

      expect(await fs.stat(dir)).toBe('dir')
      expect(await fs.stat(join(dir, 'file.txt'))).toBe('file')
      expect(await fs.stat(join(dir, 'sub'))).toBe('dir')
      // The refusal the worktree paths depend on: a symlink is never a directory they may use.
      expect(await fs.stat(join(dir, 'link-to-dir'))).toBe('other')
      expect(await fs.stat(join(dir, 'nope'))).toBe('missing')
    })

    it('creates parents on the way, like `mkdir -p`', async () => {
      const nested = join(root, 'mk', 'a', 'b')
      await fs.mkdir(nested)
      expect(await fs.stat(nested)).toBe('dir')
      // Idempotent: session preparation runs it on every turn.
      await fs.mkdir(nested)
      expect(await fs.stat(nested)).toBe('dir')
    })

    it('lists entry names, and reads a file back or nothing at all', async () => {
      const dir = join(root, 'list')
      await fs.mkdir(join(dir, 'child'))
      writeFileSync(join(dir, 'a.txt'), 'A')
      expect((await fs.readdir(dir)).sort()).toEqual(['a.txt', 'child'])
      expect(await fs.readFile(join(dir, 'a.txt'))).toBe('A')
      expect(await fs.readFile(join(dir, 'missing.txt'))).toBeUndefined()
    })

    it('reads bytes bounded by a cap that refuses instead of transferring', async () => {
      const dir = join(root, 'bytes')
      await fs.mkdir(dir)
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01, 0x02])
      writeFileSync(join(dir, 'img.bin'), binary)
      const read = await fs.readFileBytes(join(dir, 'img.bin'), 1024)
      if (read === undefined || 'tooLarge' in read) throw new Error('expected bytes')
      expect(read.bytes.equals(binary)).toBe(true)
      expect(await fs.readFileBytes(join(dir, 'img.bin'), 4)).toEqual({ tooLarge: 8 })
      expect(await fs.readFileBytes(join(dir, 'absent.bin'), 1024)).toBeUndefined()
    })

    it('publishes a write atomically and leaves no staging file behind', async () => {
      const dir = join(root, 'write')
      await fs.mkdir(dir)
      const file = join(dir, 'marker.json')
      await fs.writeFile(file, '{"v":1}\n', { mode: 0o600 })
      expect(readFileSync(file, 'utf8')).toBe('{"v":1}\n')
      // Nothing half-written survives: the directory holds the target and only the target.
      expect(readdirSync(dir)).toEqual(['marker.json'])

      // A second write replaces the contents rather than appending to what was there.
      await fs.writeFile(file, '{"v":2}\n')
      expect(readFileSync(file, 'utf8')).toBe('{"v":2}\n')
      expect(readdirSync(dir)).toEqual(['marker.json'])
    })

    it('renames a staged directory onto its published name', async () => {
      const staged = join(root, 'rename', 'staged')
      const published = join(root, 'rename', 'published')
      await fs.mkdir(staged)
      await fs.rename(staged, published)
      expect(await fs.stat(staged)).toBe('missing')
      expect(await fs.stat(published)).toBe('dir')
      // A source that is not there is a failure, not a silent no-op — the caller stages first.
      await expect(fs.rename(join(root, 'rename', 'ghost'), published)).rejects.toThrow()
    })

    it('reclaims an empty directory in ONE operation, and keeps one that is not', async () => {
      // The removal itself decides, rather than a separate emptiness proof licensing a recursive
      // delete: on a volume the runtime is writing to, whatever lands between the two would go.
      const empty = join(root, 'rmdir', 'empty')
      const held = join(root, 'rmdir', 'held')
      await fs.mkdir(empty)
      await fs.mkdir(held)
      writeFileSync(join(held, 'work.txt'), 'untracked work')

      expect(await fs.rmdir(empty)).toBe(true)
      expect(await fs.stat(empty)).toBe('missing')
      expect(await fs.rmdir(held)).toBe(false)
      expect(await fs.stat(join(held, 'work.txt'))).toBe('file')
      // Nothing to remove is not a failure — the caller already saw it there a moment ago.
      expect(await fs.rmdir(join(root, 'rmdir', 'gone'))).toBe(true)
    })

    it('removes a whole tree, and says nothing when there is none', async () => {
      const tree = join(root, 'rm', 'a', 'b')
      await fs.mkdir(tree)
      writeFileSync(join(tree, 'deep.txt'), 'x')
      await fs.rmTree(join(root, 'rm', 'a'))
      expect(await fs.stat(join(root, 'rm', 'a'))).toBe('missing')
      await expect(fs.rmTree(join(root, 'rm', 'gone'))).resolves.toBeUndefined()
    })
  })
}

// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('ShimWorkspaceFs (the pod side)', () => {
  it('refuses a path outside the mount before it reaches the wire', async () => {
    const mount = tempRoot()
    const requester = shimRequester(mount, pathExecutor())
    const fs = new ShimWorkspaceFs(requester, mount)
    // The daemon composes every path it sends under the mount; one that is not is a bug on this
    // side, and the frame is never sent so the pod is never asked to judge it.
    await expect(fs.stat('/etc/passwd')).rejects.toThrow(/outside the sandbox mount/)
    expect(requester.frames).toEqual([])
  })

  it('reports a lost channel as a failure rather than as an absent marker', async () => {
    const mount = tempRoot()
    // A refusal is data ("not there"); a transport failure is not, and a caller that read it as one
    // would treat a dropped channel as evidence about the volume.
    const fs = new ShimWorkspaceFs(
      { agentId: 'bot-a', request: async () => Promise.reject(new ShimChannelLostError('renewal')) },
      mount
    )
    await expect(fs.readFile(join(mount, 'marker.json'))).rejects.toBeInstanceOf(ShimChannelLostError)
  })

  it('keeps the local seam untouched by the channel — the daemon disk is still node:fs', async () => {
    const local = tempRoot()
    const fs = new LocalWorkspaceFs()
    await fs.mkdir(join(local, 'worktrees'), 0o700)
    // The mode is honoured here, where a second principal on the host could otherwise read it.
    expect(lstatSync(join(local, 'worktrees')).mode & 0o777).toBe(0o700)
  })
})
