import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyOpenCodeHostKeys,
  openCodeConfigWithKeys,
  openCodeHostKeys,
  openCodeKeyEnv
} from '../src/runtimes/opencode-host-keys.js'
import { fakeOpenCode, openCodeKeyEntry } from './opencode-support.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const exported = (entries: unknown) => () => JSON.stringify(entries)

describe('openCodeHostKeys', () => {
  it('keeps active API keys, one per provider, sorted, and leaves every other sign-in on the host', () => {
    const keys = openCodeHostKeys(
      {},
      exported([
        openCodeKeyEntry('openai', 'fixture-openai-key'),
        openCodeKeyEntry('deepseek', 'fixture-deepseek-key'),
        openCodeKeyEntry('deepseek', 'fixture-second-key'),
        openCodeKeyEntry('inactive', 'fixture-inactive-key', false),
        openCodeKeyEntry('blank', '  '),
        openCodeKeyEntry('bad id', 'fixture-key'),
        { ...openCodeKeyEntry('anthropic', 'unused'), value: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } },
        { ...openCodeKeyEntry('azure', 'unused'), value: { type: 'external', methodID: 'cli' } },
        null,
        'not an entry'
      ])
    )
    expect(keys).toEqual([
      { provider: 'deepseek', env: openCodeKeyEnv('deepseek'), key: 'fixture-deepseek-key' },
      { provider: 'openai', env: openCodeKeyEnv('openai'), key: 'fixture-openai-key' }
    ])
  })

  it('finds none when the export fails or prints something else', () => {
    const failing = () => {
      throw new Error('spawn opencode ENOENT')
    }
    for (const run of [failing, () => 'not json', exported({ entries: [] })])
      expect(openCodeHostKeys({}, run)).toEqual([])
  })

  // The fake `opencode` is a shell script.
  it.skipIf(process.platform === 'win32')("runs the host's opencode from the PATH it is given", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-opencode-keys-')))
    roots.push(root)
    const { PATH } = fakeOpenCode(root, [openCodeKeyEntry('opencode', 'fixture-zen-key')])
    expect(openCodeHostKeys({ HOME: root, PATH }).map(({ key }) => key)).toEqual(['fixture-zen-key'])
    expect(openCodeHostKeys({ HOME: root, PATH: join(root, 'empty') })).toEqual([])
  })

  it('names each variable from a hash, so no provider id becomes part of a variable name', () => {
    expect(openCodeKeyEnv('deepseek')).toMatch(/^OPENCODE_API_[0-9A-F]{16}$/)
    expect(openCodeKeyEnv('deepseek')).not.toBe(openCodeKeyEnv('openai'))
  })
})

describe('openCodeConfigWithKeys', () => {
  it("points each provider at its variable and leaves a key the launch's config already sets, in either shape", () => {
    const raw = JSON.stringify({
      model: 'deepseek/deepseek-chat',
      provider: {
        deepseek: { options: { baseURL: 'https://api.example.test/v1' } },
        managed: { options: { apiKey: '{env:MANAGED_KEY}' } }
      },
      providers: { native: { settings: { apiKey: 'fixture-native-key' } } }
    })
    const config = JSON.parse(
      openCodeConfigWithKeys(
        raw,
        ['deepseek', 'managed', 'native', 'openai'].map((provider) => ({ provider, env: openCodeKeyEnv(provider) }))
      )
    )
    expect(config.model).toBe('deepseek/deepseek-chat')
    expect(config.provider.deepseek.options).toEqual({
      baseURL: 'https://api.example.test/v1',
      apiKey: `{env:${openCodeKeyEnv('deepseek')}}`
    })
    expect(config.provider.managed.options.apiKey).toBe('{env:MANAGED_KEY}')
    expect(config.provider.native).toBeUndefined()
    expect(config.providers.native.settings.apiKey).toBe('fixture-native-key')
    expect(config.provider.openai.options.apiKey).toBe(`{env:${openCodeKeyEnv('openai')}}`)
  })

  it('leaves a launch with no keys unchanged', () => {
    expect(JSON.parse(openCodeConfigWithKeys('{"model":"m"}', []))).toEqual({ model: 'm' })
  })
})

describe('applyOpenCodeHostKeys', () => {
  it('puts each key in its own variable and nothing in the config text itself', () => {
    const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt"}' }
    applyOpenCodeHostKeys(env, [{ provider: 'openai', env: openCodeKeyEnv('openai'), key: 'fixture-openai-key' }])
    expect(env[openCodeKeyEnv('openai')]).toBe('fixture-openai-key')
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('fixture-openai-key')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe('openai/gpt')
  })

  it('leaves the environment untouched without keys', () => {
    const env: Record<string, string> = {}
    applyOpenCodeHostKeys(env, [])
    expect(env).toEqual({})
  })
})
