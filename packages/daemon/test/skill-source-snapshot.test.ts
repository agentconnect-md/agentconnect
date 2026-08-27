import { createServer } from 'node:net'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SKILL_SOURCE_SNAPSHOT_LIMITS,
  SkillSourceSnapshotError,
  snapshotLocalSkillSource
} from '../src/skills/skill-source-snapshot.js'

const roots: string[] = []

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function freshDestination(): Promise<string> {
  const parent = await temporary('ac-snapshot-parent-')
  await chmod(parent, 0o700)
  return join(parent, 'snapshot')
}

async function collection(order: 'forward' | 'reverse' = 'forward'): Promise<string> {
  const root = await temporary('ac-snapshot-source-')
  const files = [
    { path: '.hidden', body: 'hidden\n', mode: 0o600 },
    { path: 'bundle/SKILL.md', body: '---\nname: bundle\ndescription: test\n---\n', mode: 0o666 },
    { path: 'bundle/bin/run.sh', body: '#!/bin/sh\necho run\n', mode: 0o711 }
  ]
  if (order === 'reverse') files.reverse()
  for (const file of files) {
    await mkdir(join(root, ...file.path.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...file.path.split('/')), file.body)
    await chmod(join(root, ...file.path.split('/')), file.mode)
  }
  await mkdir(join(root, 'bundle', 'empty'))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('snapshotLocalSkillSource', () => {
  // Asserts copied-file mode bits, which Windows does not carry.
  it.skipIf(process.platform === 'win32')(
    'copies a collection into a fresh private tree and returns a canonical manifest',
    async () => {
      const source = await collection()
      const destination = await freshDestination()

      const result = await snapshotLocalSkillSource(source, destination)

      expect(DEFAULT_SKILL_SOURCE_SNAPSHOT_LIMITS).toMatchObject({
        maxFiles: 64,
        maxTotalBytes: 4 * 1024 * 1024,
        maxFileBytes: 512 * 1024
      })
      expect(result.files.map((file) => file.path)).toEqual(['.hidden', 'bundle/SKILL.md', 'bundle/bin/run.sh'])
      expect(result.files.map((file) => file.mode)).toEqual([0o644, 0o644, 0o755])
      expect(result.fileCount).toBe(3)
      expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.size, 0))
      expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(result.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

      expect(await readFile(join(destination, 'bundle/bin/run.sh'), 'utf8')).toContain('echo run')
      expect(existsSync(join(destination, 'bundle/empty'))).toBe(true)
      expect((await lstat(destination)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(destination, 'bundle'))).mode & 0o777).toBe(0o700)
      expect((await lstat(join(destination, '.hidden'))).mode & 0o777).toBe(0o644)
      expect((await lstat(join(destination, 'bundle/bin/run.sh'))).mode & 0o777).toBe(0o755)
    }
  )

  it('produces the same digest across absolute roots, creation order, and mtimes', async () => {
    const first = await collection('forward')
    const second = await collection('reverse')
    await utimes(join(first, '.hidden'), new Date(1_000), new Date(2_000))
    await utimes(join(second, '.hidden'), new Date(3_000), new Date(4_000))

    const one = await snapshotLocalSkillSource(first, await freshDestination())
    const two = await snapshotLocalSkillSource(second, await freshDestination())

    expect(one.files).toEqual(two.files)
    expect(one.sha256).toBe(two.sha256)
  })

  it('accepts a collection root when SKILL.md is nested, but requires at least one manifest', async () => {
    const source = await temporary('ac-snapshot-source-')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'nested', 'SKILL.md'), 'skill')
    await expect(snapshotLocalSkillSource(source, await freshDestination())).resolves.toMatchObject({ fileCount: 1 })

    const missing = await temporary('ac-snapshot-source-')
    await writeFile(join(missing, 'README.md'), 'not a skill')
    const destination = await freshDestination()
    await expect(snapshotLocalSkillSource(missing, destination)).rejects.toThrow('contains no SKILL.md')
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects symlinks without copying through them and leaves no destination', async () => {
    const source = await temporary('ac-snapshot-source-')
    const outside = await temporary('ac-snapshot-outside-')
    await writeFile(join(source, 'SKILL.md'), 'skill')
    await writeFile(join(outside, 'secret'), 'do not copy')
    await symlink(join(outside, 'secret'), join(source, 'alias'))
    const destination = await freshDestination()

    await expect(snapshotLocalSkillSource(source, destination)).rejects.toThrow(/link or special file/)
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects hard-linked regular files and leaves no destination', async () => {
    const source = await temporary('ac-snapshot-source-')
    await writeFile(join(source, 'SKILL.md'), 'skill')
    await writeFile(join(source, 'payload'), 'shared')
    await link(join(source, 'payload'), join(source, 'alias'))
    const destination = await freshDestination()

    await expect(snapshotLocalSkillSource(source, destination)).rejects.toThrow(/hard-linked/)
    expect(existsSync(destination)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('rejects socket entries as special files', async () => {
    const source = await temporary('ac-snapshot-source-')
    await writeFile(join(source, 'SKILL.md'), 'skill')
    const socket = join(source, 'agent.sock')
    const server = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(socket, resolveListen)
    })
    try {
      await expect(snapshotLocalSkillSource(source, await freshDestination())).rejects.toThrow(/special file/)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })

  it('rejects compatibility-normalized and case-folded collisions', async () => {
    const source = await temporary('ac-snapshot-source-')
    await writeFile(join(source, 'SKILL.md'), 'skill')
    // Fullwidth A and ASCII a are distinct on common filesystems, but both
    // conservatively fold to `a` for a portable snapshot.
    await writeFile(join(source, '\uff21'), 'wide')
    await writeFile(join(source, 'a'), 'ascii')

    await expect(snapshotLocalSkillSource(source, await freshDestination())).rejects.toThrow(
      /case-folded or Unicode-normalized path collision/
    )
  })

  it('enforces file-count, per-file, and aggregate byte limits before destination creation', async () => {
    const source = await temporary('ac-snapshot-source-')
    await writeFile(join(source, 'SKILL.md'), '1234')
    await writeFile(join(source, 'extra'), '5678')

    const tooMany = await freshDestination()
    await expect(snapshotLocalSkillSource(source, tooMany, { limits: { maxFiles: 1 } })).rejects.toThrow(
      'too many files'
    )
    expect(existsSync(tooMany)).toBe(false)

    const oversized = await freshDestination()
    await expect(snapshotLocalSkillSource(source, oversized, { limits: { maxFileBytes: 3 } })).rejects.toThrow(
      'oversized file'
    )
    expect(existsSync(oversized)).toBe(false)

    const aggregate = await freshDestination()
    await expect(snapshotLocalSkillSource(source, aggregate, { limits: { maxTotalBytes: 7 } })).rejects.toThrow(
      'byte limit'
    )
    expect(existsSync(aggregate)).toBe(false)
  })

  // The 0700-parent requirement cannot be expressed, let alone asserted, on Windows.
  it.skipIf(process.platform === 'win32')(
    'requires a fresh destination under a daemon-owned mode-0700 parent',
    async () => {
      const source = await collection()
      const publicParent = await temporary('ac-snapshot-public-')
      await chmod(publicParent, 0o755)
      await expect(snapshotLocalSkillSource(source, join(publicParent, 'snapshot'))).rejects.toThrow('mode 0700')

      const existing = await freshDestination()
      await mkdir(existing)
      await writeFile(join(existing, 'sentinel'), 'keep')
      await expect(snapshotLocalSkillSource(source, existing)).rejects.toThrow('must be fresh')
      expect(await readFile(join(existing, 'sentinel'), 'utf8')).toBe('keep')
    }
  )

  it('rejects a destination inside the source tree', async () => {
    const source = await collection()
    await chmod(source, 0o700)
    await expect(snapshotLocalSkillSource(source, join(source, 'snapshot'))).rejects.toThrow(
      'must not be inside the skill source'
    )
  })

  it('throws a typed error for invalid limits', async () => {
    await expect(
      snapshotLocalSkillSource(await collection(), await freshDestination(), { limits: { maxFiles: 0 } })
    ).rejects.toBeInstanceOf(SkillSourceSnapshotError)
  })
})
