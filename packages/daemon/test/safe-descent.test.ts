import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirHandle, MissingPathError, UnsafePathError, withDescent } from '../src/shim/safe-descent.js'

/**
 * The descent that holds inodes instead of names.
 *
 * Its whole claim is about what happens BETWEEN a check and a use, so most of these tests perform the
 * swap for real — rename the directory aside, install a symlink at the same path, and then ask the
 * held handle what it sees. A test that only walked a well-behaved tree would pass just as well
 * against the path-based code this replaces, and would prove nothing.
 */

// `/proc/self/fd` is what makes a handle addressable at all, so there is nothing to assert elsewhere.
const linux = process.platform === 'linux'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A pod-shaped layout: the mount, the checkout under it, and a secret only the mount holds. */
function volume(): { mount: string; checkout: string } {
  const mount = mkdtempSync(join(tmpdir(), 'ac-descent-'))
  roots.push(mount)
  const checkout = join(mount, 'repo')
  mkdirSync(join(checkout, 'src'), { recursive: true })
  writeFileSync(join(checkout, 'README.md'), '# in the checkout\n')
  writeFileSync(join(checkout, 'src', 'app.ts'), 'export const real = true\n')
  writeFileSync(join(mount, 'PROVIDER_SECRET.env'), 'token=abc\n')
  return { mount, checkout }
}

describe.skipIf(!linux)('withDescent', () => {
  it('reaches the checkout and reads it', async () => {
    const { mount } = volume()
    const names = await withDescent(mount, ['repo'], async (dir) => (await dir.readdir()).map((e) => e.name).sort())
    expect(names).toEqual(['README.md', 'src'])
  })

  it('keeps reading the ORIGINAL directory after the path is renamed and replaced by a symlink', async () => {
    const { mount, checkout } = volume()
    // The sequence every previous fix failed on. The handle is taken, then the runtime moves the real
    // checkout aside and points `repo` at the mount — where the provider config lives. A path-based
    // implementation resolves `repo` again and reads the mount; this one never names it again.
    const leaked = await withDescent(mount, ['repo'], async (dir) => {
      renameSync(checkout, join(mount, 'repo.moved'))
      symlinkSync(mount, checkout, 'dir')
      const entries = (await dir.readdir()).map((e) => e.name).sort()
      // ...and the same handle still resolves children from the inode it holds.
      const file = await dir.childFile('README.md')
      try {
        const content = (await file.readFile()).toString('utf8')
        return { entries, content }
      } finally {
        await file.close()
      }
    })
    expect(leaked.entries).toEqual(['README.md', 'src'])
    expect(leaked.entries).not.toContain('PROVIDER_SECRET.env')
    expect(leaked.content).toBe('# in the checkout\n')
  })

  it('refuses a symlinked component during the walk instead of resolving it', async () => {
    const { mount, checkout } = volume()
    // Installed BEFORE the descent, so this is the ordinary containment case rather than a race: a
    // component that is a symlink is not opened at all, which is what makes each step single-valued.
    rmSync(checkout, { recursive: true, force: true })
    symlinkSync(mount, checkout, 'dir')
    await expect(withDescent(mount, ['repo'], async () => 'reached')).rejects.toBeInstanceOf(UnsafePathError)
    // `ENOTDIR`, not `ELOOP` — measured: with `O_DIRECTORY|O_NOFOLLOW` the kernel objects that the
    // object is not a directory before it objects that it is a link. The file case below is `ELOOP`.
    await expect(withDescent(mount, ['repo'], async () => 'reached')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reports an absent component as missing rather than unsafe', async () => {
    const { mount } = volume()
    // Two different answers for two different facts: a workspace still being materialized is data,
    // and a component that resolves somewhere unexpected is a refusal.
    await expect(withDescent(mount, ['not-there'], async () => 'reached')).rejects.toBeInstanceOf(MissingPathError)
  })

  it('refuses a leaf symlink on open, so a file swapped for a link is never read through', async () => {
    const { mount, checkout } = volume()
    symlinkSync(join(mount, 'PROVIDER_SECRET.env'), join(checkout, 'sneaky.env'))
    await withDescent(mount, ['repo'], async (dir) => {
      await expect(dir.childFile('sneaky.env')).rejects.toMatchObject({ code: 'ELOOP' })
    })
  })

  it('refuses anything that is not one plain component, which the whole walk depends on', async () => {
    const { mount } = volume()
    await withDescent(mount, ['repo'], async (dir) => {
      for (const bad of ['..', '.', '', 'a/b', 'a\0b']) {
        await expect(dir.childDir(bad)).rejects.toBeInstanceOf(UnsafePathError)
      }
    })
  })

  it('writes and renames through the handle, so a publish lands in the validated directory', async () => {
    const { mount, checkout } = volume()
    const { writeFile, rename } = await import('node:fs/promises')
    await withDescent(mount, ['repo'], async (dir) => {
      await writeFile(dir.childPath('.tmp-edit'), 'published\n', { flag: 'wx' })
      // Swap the path mid-operation: the rename must still land in the directory the handle holds.
      renameSync(checkout, join(mount, 'repo.moved'))
      symlinkSync(mount, checkout, 'dir')
      await rename(dir.childPath('.tmp-edit'), dir.childPath('notes.md'))
    })
    expect(readFileSync(join(mount, 'repo.moved', 'notes.md'), 'utf8')).toBe('published\n')
    // Nothing was created in the mount, which is where a path-based rename would have put it.
    expect(() => readFileSync(join(mount, 'notes.md'))).toThrow()
  })

  it('closes every handle it opened, including on the failing path', async () => {
    const { mount } = volume()
    const before = openDescriptors()
    await withDescent(mount, ['repo'], async () => undefined)
    await withDescent(mount, ['repo', 'src'], async () => undefined)
    await expect(withDescent(mount, ['nope'], async () => undefined)).rejects.toBeInstanceOf(MissingPathError)
    // A descent that leaked would climb with every request the console makes, which is the failure
    // mode this shape (open, use, close in one call) exists to make impossible.
    expect(openDescriptors()).toBe(before)
  })

  it('refuses an anchor that is not absolute, and one that is not there', async () => {
    await expect(DirHandle.openAnchor('relative/path')).rejects.toBeInstanceOf(UnsafePathError)
    await expect(DirHandle.openAnchor('/definitely/not/here')).rejects.toBeInstanceOf(MissingPathError)
  })
})

/** This process's open descriptors, for the leak assertion above. */
function openDescriptors(): number {
  return readdirSync('/proc/self/fd').length
}
