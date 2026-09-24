import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isRecognizedCredentialEnv, prepareMicrosandboxCredentials } from '../src/microsandbox/secrets.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function home(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-msb-env-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), JSON.stringify(content))
  }
  return root
}

// session-executors.md §8: what a holder strips from a placed launch is what the executor's preparers bind.
describe('the provider credentials a runtime recognizes', () => {
  it.each([
    ['dsh-acp', {}, { DEEPSEEK_API_KEY: 'fixture-deepseek-key' }],
    ['claude-acp', { '.claude.json': { primaryApiKey: 'fixture-claude-key' } }, {}],
    ['codex-acp', { '.codex/auth.json': { OPENAI_API_KEY: 'fixture-codex-key' } }, {}],
    ['opencode', { '.local/share/opencode/auth.json': { opencode: { type: 'api', key: 'fixture-zen-key' } } }, {}]
  ])('covers every variable the %s preparer binds', (runtimeId, files, env) => {
    const credentials = prepareMicrosandboxCredentials(runtimeId, undefined, { HOME: home(files), ...env })
    expect(credentials?.secrets.length).toBeGreaterThan(0)
    for (const secret of credentials!.secrets)
      expect(isRecognizedCredentialEnv(runtimeId, undefined, secret.env)).toBe(true)
  })

  it("is the runtime's own key and binding, never another runtime's or an endpoint setting", () => {
    expect(isRecognizedCredentialEnv('claude-acp', undefined, 'ANTHROPIC_API_KEY')).toBe(true)
    expect(isRecognizedCredentialEnv('codex-acp', undefined, 'OPENAI_API_KEY')).toBe(true)
    expect(isRecognizedCredentialEnv('claude-acp', undefined, 'DEEPSEEK_API_KEY')).toBe(false)
    expect(isRecognizedCredentialEnv('claude-acp', undefined, 'ANTHROPIC_BASE_URL')).toBe(false)
    expect(isRecognizedCredentialEnv('dsh-acp', undefined, 'DEEPSEEK_BASE_URL')).toBe(false)
    expect(isRecognizedCredentialEnv('opencode', undefined, 'OPENCODE_API_KEY')).toBe(false)
    expect(isRecognizedCredentialEnv('arbitrary-acp', undefined, 'ANTHROPIC_API_KEY')).toBe(false)
  })
})
