import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findRepairableTrees,
  missingRuntimePackage,
  npmRepairEnv,
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

function tree(home: string, name: string, opts: { declares?: boolean; installed?: boolean }): string {
  const dir = join(home, '.npm', '_npx', name)
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

  it('repairs only a tree that declares the package and has not installed it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    const broken = tree(home, 'broken', { declares: true })
    tree(home, 'healthy', { declares: true, installed: true })
    tree(home, 'unrelated', {})
    expect(findRepairableTrees(home, PKG)).toEqual([broken])
    expect(planRuntimeInstallRepair(home, CODEX_FAILURE)).toEqual({ tree: broken, pkg: PKG })
  })

  it('plans nothing when the failure is unrelated or the tree is already whole', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    tree(home, 'healthy', { declares: true, installed: true })
    expect(planRuntimeInstallRepair(home, CODEX_FAILURE)).toBeUndefined()
    expect(planRuntimeInstallRepair(home, 'ECONNREFUSED')).toBeUndefined()
  })

  it('never lets npm run lifecycle scripts, and reports whether the package landed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-repair-'))
    const broken = tree(home, 'broken', { declares: true })
    const plan = { tree: broken, pkg: PKG }
    const seen: string[][] = []
    const installing = await repairRuntimeInstall(plan, {}, async (dir, args) => {
      seen.push(args)
      mkdirSync(join(dir, 'node_modules', PKG), { recursive: true })
    })
    expect(installing).toBe(true)
    expect(seen[0]).toContain('--ignore-scripts')
    expect(seen[0]).toContain('--include=optional')

    const idle = await repairRuntimeInstall(
      { tree: tree(home, 'other', { declares: true }), pkg: PKG },
      {},
      async () => {}
    )
    expect(idle).toBe(false)
  })

  it('hands npm an allowlist, so an agent-authored .npmrc has no daemon secret to interpolate', () => {
    const env = npmRepairEnv('/agents/a/home', {
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      npm_config_cache: '/elsewhere',
      NPM_CONFIG_PREFIX: '/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      HOME: '/root'
    })
    // The repair env pins USERPROFILE alongside HOME on Windows, where that is the one `~` reads.
    expect(env).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      HOME: '/agents/a/home',
      ...(process.platform === 'win32' ? { USERPROFILE: '/agents/a/home' } : {})
    })
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
