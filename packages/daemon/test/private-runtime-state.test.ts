import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_STATE_SECRETS,
  CODEX_STATE_SECRETS,
  privateRuntimeState
} from '../src/runtimes/private-runtime-state.js'

// What the model's tools may do with a runtime's private state directory in a session HOME: read it back (Codex
// execs its linux-sandbox helper from it, Claude reads its saved tool results), never change it, never read a secret.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-private-state-')))
  roots.push(root)
  return root
}

describe('privateRuntimeState', () => {
  it('keeps a Codex home read-only and denies the seeded config and the shared file its credential link points at', () => {
    const root = scratch()
    const host = join(root, 'host-auth.json')
    writeFileSync(host, '{}')
    const codex = join(root, 'home', '.codex')
    mkdirSync(join(codex, 'tmp', 'arg0', 'codex-arg0abc'), { recursive: true })
    mkdirSync(join(codex, 'sessions'))
    writeFileSync(join(codex, 'config.toml'), '')
    writeFileSync(join(codex, 'logs_2.sqlite'), '')
    symlinkSync(host, join(codex, 'auth.json'))

    const state = privateRuntimeState(codex, CODEX_STATE_SECRETS)
    expect(state.readOnly).toEqual([codex])
    // Not the link itself: it sits under the writable HOME, and Codex refuses to mask a path crossing a writable symlink.
    expect(state.secret.sort()).toEqual([join(codex, 'config.toml'), host].sort())
    // The helper Codex execs, and the runtime's own logs and rollouts, are not secrets.
    const inCodex = state.secret.filter((path) => path.startsWith(`${codex}/`)).map((path) => path.slice(codex.length))
    expect(
      inCodex.some((path) => path.startsWith('/tmp') || path.startsWith('/sessions') || path.endsWith('.sqlite'))
    ).toBe(false)
  })

  it('denies the file a dangling credential link will point at, before a login creates it', () => {
    const root = scratch()
    const codex = join(root, '.codex')
    mkdirSync(codex)
    symlinkSync(join(root, 'host', 'auth.json'), join(codex, 'auth.json'))
    expect(privateRuntimeState(codex, CODEX_STATE_SECRETS).secret).toEqual([join(root, 'host', 'auth.json')])
  })

  it("leaves Claude's tool results and synced skills readable, and denies the backups of its global config from the first launch", () => {
    const claude = join(scratch(), '.claude')
    mkdirSync(join(claude, 'projects', 'p', 's', 'tool-results'), { recursive: true })
    mkdirSync(join(claude, 'skills', 'synced'), { recursive: true })
    writeFileSync(join(claude, '.claude.json'), '{}')

    const state = privateRuntimeState(claude, CLAUDE_STATE_SECRETS)
    // Claude creates `backups/` later, with copies of its global config: it exists now, so it is denied now.
    expect(existsSync(join(claude, 'backups'))).toBe(true)
    expect(state.secret.sort()).toEqual([join(claude, '.claude.json'), join(claude, 'backups')].sort())
    expect(state.readOnly).toEqual([claude])
  })

  it('names nothing for a runtime that has no private state directory', () => {
    expect(privateRuntimeState(join(scratch(), '.codex'), CODEX_STATE_SECRETS)).toEqual({ readOnly: [], secret: [] })
  })
})
