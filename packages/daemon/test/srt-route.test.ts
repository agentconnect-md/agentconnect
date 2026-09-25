import { describe, expect, it } from 'vitest'
import { appendGitConfig, applySrtProxyEnv, srtGitEnv } from '../src/shim/srt-route.js'

// session-executors.md §5: inside SRT's network namespace its proxy bridge is the only route out, for runtimes and for the holder's Git alike.
const BRIDGE = 'http://srt:token@localhost:3128'
const SRT = {
  SANDBOX_RUNTIME: '1',
  HTTP_PROXY: BRIDGE,
  HTTPS_PROXY: BRIDGE,
  https_proxy: BRIDGE,
  NO_PROXY: 'localhost,127.0.0.1',
  NODE_USE_ENV_PROXY: '1',
  PATH: '/usr/bin'
}
const REMOTE = 'https://example.test/example-org/example-repo.git'

/** The command-scope Git config an env carries, in order. */
function gitConfig(env: Record<string, string> | undefined): Array<[string, string]> {
  const count = Number(env?.GIT_CONFIG_COUNT ?? 0)
  return Array.from({ length: count }, (_, i) => [env![`GIT_CONFIG_KEY_${i}`]!, env![`GIT_CONFIG_VALUE_${i}`]!])
}

describe("SRT's route out", () => {
  it('appends Git config after what an env already carries', () => {
    const env: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: ''
    }
    appendGitConfig(env, [['http.proxyAuthMethod', 'basic']])
    expect(gitConfig(env)).toEqual([
      ['core.hooksPath', ''],
      ['http.proxyAuthMethod', 'basic']
    ])
    const fresh: Record<string, string> = {}
    appendGitConfig(fresh, [['a.b', 'c']])
    expect(gitConfig(fresh)).toEqual([['a.b', 'c']])
  })

  it("hands a runtime the bridge over the launch's proxy, with Basic proxy auth added to its Git config", () => {
    const env: Record<string, string> = {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null'
    }
    applySrtProxyEnv(env, SRT)
    expect(env).toMatchObject({ HTTPS_PROXY: BRIDGE, https_proxy: BRIDGE, NO_PROXY: 'localhost,127.0.0.1' })
    expect(env.SANDBOX_RUNTIME).toBeUndefined()
    // Without it Git answers the proxy's 407 by asking the launch's credential helper for the proxy.
    expect(gitConfig(env)).toEqual([
      ['core.hooksPath', '/dev/null'],
      ['http.proxyAuthMethod', 'basic']
    ])
    // A bridge that asks for no credentials needs no auth method.
    const open: Record<string, string> = {}
    applySrtProxyEnv(open, { ...SRT, HTTPS_PROXY: 'http://localhost:3128' })
    expect(gitConfig(open)).toEqual([])
  })

  it('changes nothing outside SRT, whatever proxy the shim was given', () => {
    const env: Record<string, string> = { HTTPS_PROXY: 'http://proxy.example.test:8080' }
    applySrtProxyEnv(env, { ...SRT, SANDBOX_RUNTIME: undefined })
    expect(env).toEqual({ HTTPS_PROXY: 'http://proxy.example.test:8080' })
    const sent = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${REMOTE}.proxy`, GIT_CONFIG_VALUE_0: '' }
    expect(srtGitEnv(sent, { HTTPS_PROXY: BRIDGE })).toBe(sent)
    expect(srtGitEnv(undefined, { HTTPS_PROXY: BRIDGE })).toBeUndefined()
  })

  it("points the holder's empty proxy pins at the bridge and keeps every other setting it sent", () => {
    const sent = {
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: `http.${REMOTE}.proxy`,
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: '/opt/example/git-credential',
      GIT_CONFIG_KEY_3: 'remote.agentconnect-example.proxy',
      GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: `http.${REMOTE}.followRedirects`,
      GIT_CONFIG_VALUE_4: 'false'
    }
    const composed = srtGitEnv(sent, SRT)!
    expect(gitConfig(composed)).toEqual([
      ['credential.helper', ''],
      [`http.${REMOTE}.proxy`, BRIDGE],
      ['credential.helper', '/opt/example/git-credential'],
      ['remote.agentconnect-example.proxy', BRIDGE],
      [`http.${REMOTE}.followRedirects`, 'false'],
      ['http.proxyAuthMethod', 'basic']
    ])
    expect(composed).toMatchObject({ PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null', HTTPS_PROXY: BRIDGE })
    // The holder's env is not mutated: a retried request composes from what was sent.
    expect(sent.GIT_CONFIG_VALUE_1).toBe('')
  })

  it("composes from the shim's own env when the holder sent none", () => {
    const composed = srtGitEnv(undefined, SRT)!
    expect(composed).toMatchObject({ PATH: '/usr/bin', HTTPS_PROXY: BRIDGE })
    expect(gitConfig(composed)).toEqual([['http.proxyAuthMethod', 'basic']])
  })
})
