import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { applySrtProxyEnv, srtGitEnv } from '../src/shim/srt-route.js'

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
  it("hands a runtime the bridge over the launch's proxy, with Basic proxy auth in Git's own variable", () => {
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
    expect(env.GIT_HTTP_PROXY_AUTHMETHOD).toBe('basic')
    expect(gitConfig(env)).toEqual([['core.hooksPath', '/dev/null']])
    // A bridge that asks for no credentials needs no auth method.
    const open: Record<string, string> = {}
    applySrtProxyEnv(open, { ...SRT, HTTPS_PROXY: 'http://localhost:3128' })
    expect(open.GIT_HTTP_PROXY_AUTHMETHOD).toBeUndefined()
  })

  // POSIX only: SRT runs on Linux and macOS.
  it.skipIf(process.platform === 'win32')(
    "keeps Git's Basic proxy auth in a child whose runtime drops credential-shaped names",
    async () => {
      const asked: Array<string | undefined> = []
      const proxy = createServer()
      // A CONNECT without credentials is refused outright, so only a first request already carrying them is seen with any.
      proxy.on('connect', (req, socket) => {
        asked.push(req.headers['proxy-authorization'])
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      try {
        const bridge = `http://srt:token@127.0.0.1:${(proxy.address() as AddressInfo).port}`
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? '/usr/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0'
        }
        applySrtProxyEnv(env, { ...SRT, HTTP_PROXY: bridge, HTTPS_PROXY: bridge, https_proxy: bridge })
        const scrubbed = Object.fromEntries(
          Object.entries(env).filter(([name]) => !/KEY|PASSWORD|SECRET|TOKEN/i.test(name))
        )
        await promisify(execFile)('git', ['ls-remote', REMOTE], { env: scrubbed }).catch(() => undefined)
        expect(asked[0]).toBe(`Basic ${Buffer.from('srt:token').toString('base64')}`)
      } finally {
        await new Promise((resolve) => proxy.close(resolve))
      }
    }
  )

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
      [`http.${REMOTE}.followRedirects`, 'false']
    ])
    expect(composed).toMatchObject({
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HTTPS_PROXY: BRIDGE,
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic'
    })
    // The holder's env is not mutated: a retried request composes from what was sent.
    expect(sent.GIT_CONFIG_VALUE_1).toBe('')
  })

  it("composes from the shim's own env when the holder sent none", () => {
    const composed = srtGitEnv(undefined, SRT)!
    expect(composed).toMatchObject({ PATH: '/usr/bin', HTTPS_PROXY: BRIDGE, GIT_HTTP_PROXY_AUTHMETHOD: 'basic' })
    expect(gitConfig(composed)).toEqual([])
  })
})
