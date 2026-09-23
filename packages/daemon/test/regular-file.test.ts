import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegularFile, readRegularFileSync, RegularFileError } from '../src/fs/regular-file.js'
import { fifoWriter, killFifoWriters, mkfifo } from './fifo-support.js'

const roots: string[] = []

afterEach(() => {
  killFifoWriters()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-regular-file-'))
  roots.push(dir)
  return dir
}

const readers = [
  {
    name: 'sync',
    read: async (path: string, max: number, follow?: boolean) =>
      readRegularFileSync(path, max, { followSymlinks: follow })
  },
  {
    name: 'async',
    read: (path: string, max: number, follow?: boolean) => readRegularFile(path, max, { followSymlinks: follow })
  }
]

describe.each(readers)('readRegularFile ($name)', ({ read }) => {
  it('reads a regular file whole and refuses one past its bound', async () => {
    const path = join(root(), 'config.json')
    writeFileSync(path, '{"ok":true}')
    expect((await read(path, 64)).toString('utf8')).toBe('{"ok":true}')
    await expect(read(path, 4)).rejects.toMatchObject({ reason: 'too-large', size: 11 })
  })

  it('lets a missing file surface as ENOENT', async () => {
    await expect(read(join(root(), 'absent.json'), 64)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a final symlink unless told to follow it', async () => {
    const dir = root()
    writeFileSync(join(dir, 'real.json'), 'real')
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'))
    await expect(read(join(dir, 'link.json'), 64)).rejects.toBeInstanceOf(RegularFileError)
    expect((await read(join(dir, 'link.json'), 64, true)).toString('utf8')).toBe('real')
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO at once instead of waiting for its writer', async () => {
    const path = join(root(), 'settings.json')
    mkfifo(path)
    // A blocking open would sit here until the writer arrives, then read its bytes.
    fifoWriter(path, '{"planted":true}', 2000)
    const started = Date.now()
    await expect(read(path, 64)).rejects.toMatchObject({ reason: 'not-a-file' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink to a device even when following it', async () => {
    const path = join(root(), 'auth.json')
    symlinkSync('/dev/zero', path)
    await expect(read(path, 64, true)).rejects.toMatchObject({ reason: 'not-a-file' })
    await expect(read(path, 64)).rejects.toMatchObject({ reason: 'not-a-file' })
  })
})
