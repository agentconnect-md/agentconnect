import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findRepairableTrees,
  missingRuntimePackage,
  planRuntimeInstallRepair,
  repairRuntimeInstall
} from '../src/runtimes/runtime-install-repair.js'
import { startFailureDetail } from '../src/daemon/text.js'

const PKG = '@openai/codex-linux-x64'

// The adapter reports the fault as its own crash: codex-acp captures the codex child's stderr
// and returns it as an ACP RequestError, so the daemon sees the wrapper line AND the real cause.
const CODEX_FAILURE = [
  'Codex process has exited with code 1:',
  'file:///home/dev/.agentconnect/agents/test2/home/.npm/_npx/8b5/node_modules/@openai/codex/bin/codex.js:105',
  '  throw new Error(',
  '        ^',
  `Error: Missing optional dependency ${PKG}. Reinstall Codex: npm install -g @openai/codex@latest`,
  '    at findCodexExecutable (file:///home/dev/.npm/_npx/8b5/node_modules/@openai/codex/bin/codex.js:105:9)'
].join('\n')

// The store nests a scoped package one level deeper, which is the depth the repair scan must reach.
function tree(root: string, name: string, opts: { declares?: boolean; installed?: boolean }): string {
  const dir = join(root, 'runtimes', '@agentconnect.md', name)
  mkdirSync(dir, { recursive: true })
  if (opts.declares) {
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${PKG}`]: { version: '0.147.0-linux-x64', optional: true } } })
    )
  }
  if (opts.installed) mkdirSync(join(dir, 'node_modules', PKG), { recursive: true })
  return dir
}

describe('runtime install repair', () => {
  it('reads the missing package out of the adapter failure', () => {
    expect(missingRuntimePackage(CODEX_FAILURE)).toBe(PKG)
    expect(missingRuntimePackage('Codex process has exited with code 1: killed')).toBeUndefined()
  })

  it('refuses anything that is not a plain npm package name', () => {
    expect(missingRuntimePackage('Missing optional dependency ../../etc/passwd')).toBeUndefined()
    expect(missingRuntimePackage('Missing optional dependency https://evil.test/x.tgz')).toBeUndefined()
    expect(missingRuntimePackage('Missing optional dependency @openai/codex@file:/tmp/x')).toBeUndefined()
  })

  it('repairs only a daemon-owned tree that declares the package and has not installed it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    const broken = tree(root, 'broken@1.0.0', { declares: true })
    tree(root, 'healthy@1.0.0', { declares: true, installed: true })
    tree(root, 'unrelated@1.0.0', {})
    expect(findRepairableTrees(root, PKG)).toEqual([broken])
    expect(planRuntimeInstallRepair(root, CODEX_FAILURE)).toEqual({ tree: broken, pkg: PKG })
  })

  it('looks in the daemon-owned store, never in an agent HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    const home = join(root, 'agents', 'a', 'home')
    const npx = join(home, '.npm', '_npx', 'deadbeef')
    mkdirSync(npx, { recursive: true })
    writeFileSync(
      join(npx, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${PKG}`]: { optional: true } } })
    )
    expect(findRepairableTrees(root, PKG)).toEqual([])
    expect(planRuntimeInstallRepair(root, CODEX_FAILURE)).toBeUndefined()
  })

  it('plans nothing when the failure is unrelated or the tree is already whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    tree(root, 'healthy@1.0.0', { declares: true, installed: true })
    expect(planRuntimeInstallRepair(root, CODEX_FAILURE)).toBeUndefined()
    expect(planRuntimeInstallRepair(root, 'ECONNREFUSED')).toBeUndefined()
  })

  it('reifies the tree in place and reports whether the package landed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    const broken = tree(root, 'broken@1.0.0', { declares: true })
    const plan = { tree: broken, pkg: PKG }
    const seen: { args: string[]; cwd?: string }[] = []
    const installing = await repairRuntimeInstall(plan, async (args, opts) => {
      seen.push({ args, cwd: opts?.cwd })
      mkdirSync(join(opts!.cwd!, 'node_modules', PKG), { recursive: true })
      return ''
    })
    expect(installing).toBe(true)
    expect(seen[0]!.cwd).toBe(broken)
    expect(seen[0]!.args).toContain('--ignore-scripts')
    expect(seen[0]!.args).toContain('--include=optional')

    const idle = await repairRuntimeInstall(
      { tree: tree(root, 'other@1.0.0', { declares: true }), pkg: PKG },
      async () => ''
    )
    expect(idle).toBe(false)
  })
})

describe('startFailureDetail', () => {
  it('names the underlying cause rather than the adapter wrapper line', () => {
    expect(startFailureDetail(new Error(CODEX_FAILURE))).toBe(
      `Error: Missing optional dependency ${PKG}. Reinstall Codex: npm install -g @openai/codex@latest`
    )
  })

  it('reduces absolute paths to basenames so a console user learns no daemon layout', () => {
    const detail = startFailureDetail(
      new Error('Error: cannot read /home/dev/.agentconnect/agents/a/home/.codex/auth.json')
    )
    expect(detail).toBe('Error: cannot read auth.json')
  })

  it('redacts a path however it is introduced, and leaves a scoped package name alone', () => {
    expect(startFailureDetail(new Error('Error: spawn failed cwd=/home/dev/agents/a/workspace'))).toBe(
      'Error: spawn failed cwd=workspace'
    )
    expect(startFailureDetail(new Error('Error: npm --prefix=/home/dev/.npm/_npx/8b5 failed'))).toBe(
      'Error: npm --prefix=8b5 failed'
    )
    expect(startFailureDetail(new Error('Error: missing [/home/dev/.codex/config.toml]'))).toBe(
      'Error: missing [config.toml]'
    )
    expect(startFailureDetail(new Error(`Error: Missing optional dependency ${PKG}`))).toBe(
      `Error: Missing optional dependency ${PKG}`
    )
    expect(startFailureDetail(new Error(String.raw`Error: ENOENT C:\Users\dev\.agentconnect\agents\a\home`))).toBe(
      'Error: ENOENT home'
    )
  })

  it('falls back to the first line and stays bounded', () => {
    expect(startFailureDetail(new Error('spawn npx ENOENT'))).toBe('spawn npx ENOENT')
    expect(startFailureDetail(new Error(`Error: ${'x'.repeat(400)}`), 40)).toHaveLength(40)
  })
})
