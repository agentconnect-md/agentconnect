import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree, removeTreeSync } from '../src/workspace/remove-tree.js'

/** A tree shaped like an installed skill bundle: no owner-write on its directories or files. */
async function lockedTree(root: string): Promise<string> {
  const bundle = join(root, '.claude/skills/doc-skill')
  await mkdir(join(bundle, 'references'), { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), 'skill', { mode: 0o400 })
  await writeFile(join(bundle, 'references/a.md'), 'a', { mode: 0o400 })
  await chmod(join(bundle, 'references'), 0o500)
  await chmod(bundle, 0o500)
  return bundle
}

describe.skipIf(process.platform === 'win32')('removeTree', () => {
  it('removes a tree whose directories have no owner-write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-remove-tree-'))
    await lockedTree(root)
    await removeTree(root)
    expect(existsSync(root)).toBe(false)
  })

  it('removes it synchronously too, and a missing tree is not an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-remove-tree-'))
    await lockedTree(root)
    removeTreeSync(root)
    expect(existsSync(root)).toBe(false)
    removeTreeSync(root)
    await removeTree(root)
  })
})
