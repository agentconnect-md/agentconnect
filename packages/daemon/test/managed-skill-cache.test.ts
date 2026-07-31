import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedSkillChunk, ManagedSkillEntry } from '@agentconnect.md/protocol'
import { ManagedSkillCache } from '../src/skills/managed-skill-cache.js'

const SKILL_ID = '11111111-1111-4111-8111-111111111111'

function archiveOf(
  name = 'deploy-safe',
  extra: Zippable = { 'references/runbook.md': strToU8('# Runbook\n') }
): Uint8Array {
  const entries: Zippable = {
    [`${name}/SKILL.md`]: strToU8(`---\nname: ${name}\ndescription: Deploy safely\n---\n# Deploy\n`)
  }
  for (const [path, value] of Object.entries(extra)) entries[`${name}/${path}`] = value
  return zipSync(entries, { level: 6 })
}

function bindingFor(archive: Uint8Array, revision = 1, name = 'deploy-safe'): ManagedSkillEntry {
  return {
    id: SKILL_ID,
    name,
    revision,
    digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`
  }
}

function readerFor(archive: Uint8Array, binding: ManagedSkillEntry) {
  return vi.fn(async (req: { offset: number; limit: number }): Promise<ManagedSkillChunk> => {
    const end = Math.min(archive.byteLength, req.offset + req.limit)
    return {
      managedSkillId: binding.id,
      revision: binding.revision,
      digest: binding.digest,
      size: archive.byteLength,
      offset: req.offset,
      nextOffset: end,
      data: Buffer.from(archive.subarray(req.offset, end)).toString('base64'),
      truncated: end < archive.byteLength
    }
  })
}

describe('ManagedSkillCache', () => {
  it('downloads, verifies, and safely extracts a complete bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf()
    const binding = bindingFor(archive)
    const read = readerFor(archive, binding)
    const cache = new ManagedSkillCache(root, { read })

    const resolved = await cache.resolve({ id: 'agent-a', managedSkills: [binding] })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.name).toBe('deploy-safe')
    expect(await readFile(join(resolved[0]!.sourceDir, 'SKILL.md'), 'utf8')).toContain('# Deploy')
    expect(await readFile(join(resolved[0]!.sourceDir, 'references/runbook.md'), 'utf8')).toContain('Runbook')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('uses an exact verified cached revision while the control plane is offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf()
    const binding = bindingFor(archive)
    await new ManagedSkillCache(root, { read: readerFor(archive, binding) }).resolve({
      id: 'agent-a',
      managedSkills: [binding]
    })
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })

    const resolved = await new ManagedSkillCache(root, { read: offline }).resolve({
      id: 'agent-a',
      managedSkills: [binding]
    })

    expect(resolved).toHaveLength(1)
    expect(offline).not.toHaveBeenCalled()
  })

  it('rebuilds a tampered extracted tree from the verified archive while offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf()
    const binding = bindingFor(archive)
    const [first] = await new ManagedSkillCache(root, { read: readerFor(archive, binding) }).resolve({
      id: 'agent-a',
      managedSkills: [binding]
    })
    await writeFile(join(first!.sourceDir, 'references/runbook.md'), 'tampered', 'utf8')
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })

    const [healed] = await new ManagedSkillCache(root, { read: offline }).resolve({
      id: 'agent-a',
      managedSkills: [binding]
    })

    expect(await readFile(join(healed!.sourceDir, 'references/runbook.md'), 'utf8')).toBe('# Runbook\n')
    expect(offline).not.toHaveBeenCalled()
  })

  it('skips a digest mismatch without blocking startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf()
    const binding = { ...bindingFor(archive), digest: `sha256:${'0'.repeat(64)}` }
    const warnings: string[] = []

    const resolved = await new ManagedSkillCache(root, {
      read: readerFor(archive, binding),
      warn: (message) => warnings.push(message)
    }).resolve({ id: 'agent-a', managedSkills: [binding] })

    expect(resolved).toEqual([])
    expect(warnings.join(' ')).toContain('digest verification failed')
  })

  it('rejects traversal paths before materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf('deploy-safe', { '../escape.txt': strToU8('no') })
    const binding = bindingFor(archive)
    const warnings: string[] = []

    const resolved = await new ManagedSkillCache(root, {
      read: readerFor(archive, binding),
      warn: (message) => warnings.push(message)
    }).resolve({ id: 'agent-a', managedSkills: [binding] })

    expect(resolved).toEqual([])
    expect(warnings.join(' ')).toMatch(/unsafe path|one expected root/)
  })

  it('rejects file/ancestor collisions before materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf('deploy-safe', {
      'references/conflict': strToU8('file'),
      'references/conflict/child.md': strToU8('child')
    })
    const binding = bindingFor(archive)
    const warnings: string[] = []

    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(archive, binding),
        warn: (message) => warnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [binding] })
    ).toEqual([])
    expect(warnings.join(' ')).toContain('file/directory path collision')
  })

  it('rejects a SKILL.md manifest whose name does not match the enabled bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = zipSync(
      {
        'deploy-safe/SKILL.md': strToU8(
          '---\nname: different-skill\ndescription: Must not install under another identity\n---\n# Wrong\n'
        )
      },
      { level: 6 }
    )
    const binding = bindingFor(archive)
    const warnings: string[] = []

    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(archive, binding),
        warn: (message) => warnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [binding] })
    ).toEqual([])
    expect(warnings.join(' ')).toContain('name does not match')
  })

  it('rejects Unix symlink entries and expanded-size bombs before inflation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const symlinkArchive = archiveOf('deploy-safe', {
      link: [strToU8('../../outside'), { os: 3, attrs: 0o120777 << 16 }]
    })
    const symlinkBinding = bindingFor(symlinkArchive)
    const symlinkWarnings: string[] = []
    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(symlinkArchive, symlinkBinding),
        warn: (message) => symlinkWarnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [symlinkBinding] })
    ).toEqual([])
    expect(symlinkWarnings.join(' ')).toContain('symbolic link')

    const bomb = archiveOf('deploy-safe', { 'assets/bomb.bin': new Uint8Array(4 * 1024 * 1024 + 1) })
    const bombBinding = bindingFor(bomb, 2)
    const bombWarnings: string[] = []
    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(bomb, bombBinding),
        warn: (message) => bombWarnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [bombBinding] })
    ).toEqual([])
    expect(bombWarnings.join(' ')).toContain('file over its size cap')
  })

  it('rejects suspicious compression ratios and inconsistent local ZIP headers before inflation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const compressedBomb = archiveOf('deploy-safe', { 'assets/repeated.bin': new Uint8Array(128 * 1024) })
    const bombBinding = bindingFor(compressedBomb)
    const bombWarnings: string[] = []
    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(compressedBomb, bombBinding),
        warn: (message) => bombWarnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [bombBinding] })
    ).toEqual([])
    expect(bombWarnings.join(' ')).toContain('compression ratio')

    const malformed = Buffer.from(archiveOf())
    // The first fflate entry begins at local header offset 0. Make its local
    // uncompressed size disagree with the authoritative central directory,
    // then recompute the outer digest so only structural validation catches it.
    malformed.writeUInt32LE(malformed.readUInt32LE(22) + 1, 22)
    const malformedBinding = bindingFor(malformed, 2)
    const malformedWarnings: string[] = []
    expect(
      await new ManagedSkillCache(root, {
        read: readerFor(malformed, malformedBinding),
        warn: (message) => malformedWarnings.push(message)
      }).resolve({ id: 'agent-a', managedSkills: [malformedBinding] })
    ).toEqual([])
    expect(malformedWarnings.join(' ')).toContain('local entry disagrees')
  })

  it('does not substitute a cached older revision when the enabled revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-managed-skills-'))
    const archive = archiveOf()
    const v1 = bindingFor(archive, 1)
    await new ManagedSkillCache(root, { read: readerFor(archive, v1) }).resolve({
      id: 'agent-a',
      managedSkills: [v1]
    })
    const v2 = { ...v1, revision: 2 }
    const warnings: string[] = []

    const resolved = await new ManagedSkillCache(root, {
      read: async () => {
        throw new Error('offline')
      },
      warn: (message) => warnings.push(message)
    }).resolve({ id: 'agent-a', managedSkills: [v2] })

    expect(resolved).toEqual([])
    expect(warnings.join(' ')).toContain('offline')
  })
})
