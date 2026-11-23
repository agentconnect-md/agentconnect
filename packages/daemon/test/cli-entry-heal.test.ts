import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCliEntry } from '../src/lifecycle/cli-upgrade.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-cli-entry-'))
  roots.push(root)
  const cli = join(root, 'cli.js')
  writeFileSync(cli, '// stand-in for the run shell’s CLI entry\n')
  return { root, cli, pointer: join(root, 'cli-entry') }
}

describe('readCliEntry', () => {
  it('restores a 0-byte pointer from the run shell’s entry', () => {
    const { root, cli, pointer } = fixture()
    // What a full disk left behind when the CLI still truncated the pointer in place.
    writeFileSync(pointer, '')
    const log = { info: vi.fn() }
    expect(readCliEntry(root, log, cli)).toBe(cli)
    expect(readFileSync(pointer, 'utf8')).toBe(`${cli}\n`)
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(log.info).toHaveBeenCalledTimes(1)
    // Healed: the next read needs no fallback and says nothing.
    expect(readCliEntry(root, log, undefined)).toBe(cli)
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('restores a missing pointer, and one that names a file that is gone', () => {
    const { root, cli, pointer } = fixture()
    expect(readCliEntry(root, undefined, cli)).toBe(cli)
    expect(readFileSync(pointer, 'utf8')).toBe(`${cli}\n`)

    writeFileSync(pointer, `${join(root, 'removed-node-version', 'cli.js')}\n`)
    expect(readCliEntry(root, undefined, cli)).toBe(cli)
    expect(readFileSync(pointer, 'utf8')).toBe(`${cli}\n`)
  })

  it('leaves a valid pointer alone', () => {
    const { root, cli, pointer } = fixture()
    const other = join(root, 'other-cli.js')
    writeFileSync(other, '')
    writeFileSync(pointer, `${other}\n`)
    expect(readCliEntry(root, undefined, cli)).toBe(other)
    expect(readFileSync(pointer, 'utf8')).toBe(`${other}\n`)
  })

  it('finds no CLI without a usable fallback, and writes nothing', () => {
    const { root, pointer } = fixture()
    writeFileSync(pointer, '')
    expect(readCliEntry(root, undefined, undefined)).toBeUndefined()
    expect(readCliEntry(root, undefined, join(root, 'gone.js'))).toBeUndefined()
    expect(readFileSync(pointer, 'utf8')).toBe('')
  })

  it('still answers with the fallback when the pointer cannot be rewritten', () => {
    const { cli } = fixture()
    expect(readCliEntry(join(tmpdir(), 'agentconnect-no-such-root', 'nested'), undefined, cli)).toBe(cli)
  })
})
