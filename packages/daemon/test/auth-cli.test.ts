import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { runAuth } from '../src/cli/auth.js'
import type { AcpHost } from '../src/acp/acp-host.js'
import type { PickerModel, PickerRow } from '../src/cli/auth-picker.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import type { RuntimeProbeResult } from '../src/runtimes/runtime-prober.js'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'

function scaffold(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-auth-'))
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  return { root, configPath }
}

function capture(): { stream: Writable; text: () => string } {
  let buf = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString()
      cb()
    }
  })
  return { stream, text: () => buf }
}

const def = (command: string): RuntimeDef => ({ command, args: ['acp'], env: [] })

function catalog(): ResolvedRuntimeCatalog {
  const entries = {
    'antigravity-acp': { runtime: def('agy'), name: 'Google Antigravity' },
    'claude-acp': { runtime: def('claude'), name: 'Claude Agent' },
    'grok-build': { runtime: def('grok'), name: 'Grok Build' }
  }
  return {
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, e]) => [
        id,
        { runtime: e.runtime, source: 'registry' as const, name: e.name, version: '', skillsAgentId: null }
      ])
    ),
    runtimes: Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, e.runtime]))
  }
}

/** An AcpHost that reports the given login methods and records what was authenticated. */
function fakeHost(methods: unknown[], calls: string[] = []): AcpHost {
  return {
    start: vi.fn(async () => {}),
    authMethods: () => methods,
    authenticate: vi.fn(async (methodId: string) => void calls.push(methodId)),
    stop: vi.fn(async () => {})
  } as unknown as AcpHost
}

const io = () => ({ input: new PassThrough() as never, output: capture().stream as never })

describe('runAuth: the runtime list', () => {
  it('lists every runtime as checking before a single verdict lands', async () => {
    const { root, configPath } = scaffold()
    let shown: PickerRow[] | undefined
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      // Never answers while the picker is open — only once the choice cancels it, which is what
      // a real sweep does now: the list must not wait for a verdict.
      probeRuntimes: async (_runtimes, opts) =>
        await new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve([]))),
      pick: async (model) => {
        shown = model.rows()
        return 'antigravity-acp'
      },
      hostFactory: () => fakeHost([{ id: 'oauth-personal', name: 'Log in with Google' }])
    })
    expect(shown).toEqual([
      { id: 'antigravity-acp', name: 'Google Antigravity', hint: 'checking…' },
      { id: 'claude-acp', name: 'Claude Agent', hint: 'checking…' },
      { id: 'grok-build', name: 'Grok Build', hint: 'checking…' }
    ])
  })

  it('keeps the order fixed and only updates each row status as verdicts land', async () => {
    const { root, configPath } = scaffold()
    let emit: ((result: RuntimeProbeResult) => void) | undefined
    const repaints: PickerRow[][] = []
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async (_runtimes, opts) => {
        emit = (result) => opts.onResult?.(result)
        return []
      },
      pick: async (model) => {
        model.subscribe?.(() => repaints.push(model.rows()))
        // Deliberately out of list order: the rows must not follow the answer order.
        emit!({ runtime: 'claude-acp', ok: true, models: ['opus', 'sonnet'], probedVersion: '0.73.0' })
        emit!({ runtime: 'grok-build', ok: false, models: [], error: 'ACP connection closed' })
        emit!({
          runtime: 'antigravity-acp',
          ok: false,
          models: [],
          error: 'Authentication required',
          authRequired: true
        })
        return undefined
      }
    })

    expect(repaints).toHaveLength(3)
    for (const rows of repaints) {
      expect(rows.map((row) => row.id)).toEqual(['antigravity-acp', 'claude-acp', 'grok-build'])
    }
    expect(repaints.at(-1)).toEqual([
      { id: 'antigravity-acp', name: 'Google Antigravity', hint: 'not logged in' },
      { id: 'claude-acp', name: 'Claude Agent', hint: 'logged in — 2 model(s), 0.73.0' },
      // A failure that is not an auth failure still reads as not logged in, with the reason.
      { id: 'grok-build', name: 'Grok Build', hint: 'not logged in — ACP connection closed' }
    ])
    // The first verdict only changed its own row.
    expect(repaints[0]!.map((row) => row.hint)).toEqual(['checking…', 'logged in — 2 model(s), 0.73.0', 'checking…'])
  })

  it('aborts the sweep as soon as a runtime is chosen', async () => {
    const { root, configPath } = scaffold()
    let signal: AbortSignal | undefined
    const calls: string[] = []
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async (_runtimes, opts) => {
        signal = opts.signal
        return []
      },
      pick: async () => {
        expect(signal?.aborted).toBe(false)
        return 'claude-acp'
      },
      hostFactory: () => fakeHost([{ id: 'oauth', name: 'Log in' }], calls)
    })
    // Nothing new is launched while the login this command exists for is running.
    expect(signal?.aborted).toBe(true)
    expect(calls).toEqual(['oauth'])
  })

  it('waits for the cancelled sweep to tear down before it returns', async () => {
    // runAuth resolving is the CLI action calling process.exit: a teardown nobody awaited leaves
    // probe children running after the command is gone.
    const { root, configPath } = scaffold()
    let torndown = false
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async (_runtimes, opts) =>
        await new Promise((resolve) => {
          // Deferred a tick past the abort, so returning before the teardown is observable.
          const tearDown = (): void => {
            torndown = true
            resolve([])
          }
          opts.signal?.addEventListener('abort', () => void setTimeout(tearDown, 10))
        }),
      pick: async () => 'claude-acp',
      hostFactory: () => fakeHost([{ id: 'oauth', name: 'Log in' }])
    })
    expect(torndown).toBe(true)
  })

  it('probes every installed runtime, keyed by id', async () => {
    const { root, configPath } = scaffold()
    const probed: string[][] = []
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async (runtimes) => {
        probed.push(Object.keys(runtimes).sort())
        return []
      },
      pick: async () => undefined
    })
    expect(probed).toEqual([['antigravity-acp', 'claude-acp', 'grok-build']])
  })

  it('skips the sweep entirely with --skip-probe', async () => {
    const { root, configPath } = scaffold()
    let shown: PickerRow[] | undefined
    let probes = 0
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      io: io(),
      skipProbe: true,
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async () => {
        probes += 1
        return []
      },
      pick: async (model) => {
        shown = model.rows()
        return undefined
      }
    })
    expect(probes).toBe(0)
    expect(shown!.map((row) => row.id)).toEqual(['antigravity-acp', 'claude-acp', 'grok-build'])
    expect(shown!.every((row) => row.hint === undefined)).toBe(true)
  })

  it('goes straight to the runtime named by --runtime, probing nothing', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    const calls: string[] = []
    let probes = 0
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'claude-acp',
      methodId: 'oauth',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      probeRuntimes: async () => {
        probes += 1
        return []
      },
      hostFactory: () => fakeHost([{ id: 'oauth', name: 'Log in' }], calls)
    })
    expect(probes).toBe(0)
    expect(calls).toEqual(['oauth'])
    expect(out.text()).toContain('✓ claude-acp is logged in on this host.')
  })
})

describe('runAuth: method selection', () => {
  it('uses the only method a runtime offers without asking', async () => {
    const { root, configPath } = scaffold()
    const calls: string[] = []
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      runtimeId: 'claude-acp',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () => fakeHost([{ id: 'only-one', name: 'Log in' }], calls),
      pick: async () => {
        throw new Error('must not ask when there is only one method')
      }
    })
    expect(calls).toEqual(['only-one'])
  })

  it('offers the methods on the same arrow-key list, never as an id to retype', async () => {
    const { root, configPath } = scaffold()
    const calls: string[] = []
    let shown: PickerRow[] | undefined
    let prompt = ''
    await runAuth({
      root,
      configPath,
      out: capture().stream,
      runtimeId: 'antigravity-acp',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () =>
        fakeHost(
          [
            { id: 'oauth-personal', name: 'Log in with Google', description: 'Your Google account' },
            { id: 'gemini-api-key', name: 'Gemini API key' },
            { type: 'terminal', id: 'tui', name: 'Log in in a terminal' }
          ],
          calls
        ),
      pick: async (model: PickerModel, _io, text) => {
        shown = model.rows()
        prompt = text
        return 'gemini-api-key'
      }
    })
    expect(prompt).toBe('How do you want to log in to antigravity-acp?')
    expect(shown).toEqual([
      { id: 'oauth-personal', name: 'Log in with Google', hint: 'Your Google account (handled by the runtime)' },
      { id: 'gemini-api-key', name: 'Gemini API key', hint: 'Gemini API key (handled by the runtime)' },
      { id: 'tui', name: 'Log in in a terminal', hint: 'Log in in a terminal (in a terminal)' }
    ])
    expect(calls).toEqual(['gemini-api-key'])
  })

  it('cancels the login when the method list is dismissed', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    const calls: string[] = []
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'antigravity-acp',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () =>
        fakeHost(
          [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' }
          ],
          calls
        ),
      pick: async () => undefined
    })
    expect(calls).toEqual([])
    expect(out.text()).not.toContain('is logged in on this host')
  })

  it('refuses a method the runtime does not offer', async () => {
    const { root, configPath } = scaffold()
    await expect(
      runAuth({
        root,
        configPath,
        out: capture().stream,
        runtimeId: 'claude-acp',
        methodId: 'nope',
        resolveCatalog: async () => catalog(),
        installed: (c) => c,
        hostFactory: () => fakeHost([{ id: 'oauth', name: 'Log in' }])
      })
    ).rejects.toThrow(/"nope" is not offered by claude-acp\. Offered: oauth/)
  })

  it('runs a terminal method as the client, and never through authenticate', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    const calls: string[] = []
    const ran: { command: string; method: string }[] = []
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'claude-acp',
      methodId: 'tui',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () => fakeHost([{ type: 'terminal', id: 'tui', name: 'Log in in a terminal' }], calls),
      runTerminalAuth: async (runtime, method) => {
        ran.push({ command: runtime.command, method: method.id })
        return 0
      }
    })
    // The spec forbids passing a terminal method to `authenticate`; the client owns it.
    expect(calls).toEqual([])
    expect(ran).toEqual([{ command: 'claude', method: 'tui' }])
    expect(out.text()).toContain('Using tui — Log in in a terminal')
    expect(out.text()).toContain('✓ claude-acp is logged in on this host.')
  })

  it('fails when the interactive login exits non-zero', async () => {
    const { root, configPath } = scaffold()
    await expect(
      runAuth({
        root,
        configPath,
        out: capture().stream,
        runtimeId: 'claude-acp',
        methodId: 'tui',
        resolveCatalog: async () => catalog(),
        installed: (c) => c,
        hostFactory: () => fakeHost([{ type: 'terminal', id: 'tui', name: 'Log in in a terminal' }]),
        runTerminalAuth: async () => 1
      })
    ).rejects.toThrow(/interactive login exited with code 1/)
  })

  it('offers the loopback paste once an agent-run login stalls, and replays it locally', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    const delivered: string[] = []
    let finishLogin = (): void => {}
    const login = new Promise<void>((resolve) => (finishLogin = resolve))
    const host = {
      start: async () => {},
      authMethods: () => [{ id: 'oauth-personal', name: 'Log in with Google' }],
      authenticate: async () => login,
      stop: async () => {}
    } as unknown as AcpHost

    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'antigravity-acp',
      methodId: 'oauth-personal',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () => host,
      pasteAfterMs: 0,
      readLine: async () => 'http://127.0.0.1:52481/?code=4/abc&state=xyz',
      deliverLoopback: async (url) => {
        delivered.push(url)
        finishLogin()
      }
    })

    expect(delivered).toEqual(['http://127.0.0.1:52481/?code=4/abc&state=xyz'])
    expect(out.text()).toContain('copy the URL of the tab that failed to load')
    expect(out.text()).toContain('✓ antigravity-acp is logged in on this host.')
  })

  it('refuses to fetch anything that is not a loopback redirect', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    const delivered: string[] = []
    let finishLogin = (): void => {}
    const login = new Promise<void>((resolve) => (finishLogin = resolve))
    const answers = ['https://evil.example.test/?code=stolen', 'http://127.0.0.1:52481/?code=ok']
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'antigravity-acp',
      methodId: 'oauth-personal',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () =>
        ({
          start: async () => {},
          authMethods: () => [{ id: 'oauth-personal', name: 'Log in with Google' }],
          authenticate: async () => login,
          stop: async () => {}
        }) as unknown as AcpHost,
      pasteAfterMs: 0,
      readLine: async () => answers.shift()!,
      deliverLoopback: async (url) => {
        delivered.push(url)
        finishLogin()
      }
    })
    // The first paste never leaves this process; the loop asks again.
    expect(delivered).toEqual(['http://127.0.0.1:52481/?code=ok'])
    expect(out.text()).toContain('not a loopback redirect URL')
  })

  it('never offers the paste when the login completes on its own', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    let asked = 0
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'claude-acp',
      methodId: 'oauth',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () => fakeHost([{ id: 'oauth', name: 'Log in' }]),
      pasteAfterMs: 50,
      readLine: async () => {
        asked += 1
        return ''
      }
    })
    expect(asked).toBe(0)
    expect(out.text()).not.toContain('copy the URL')
  })

  it('finishes on its own when the login settles while the paste prompt is waiting', async () => {
    // A browser login routinely takes longer than the paste offer's delay. Once the question is
    // on stdin, only releasing it can end the command — no keypress should be required.
    const { root, configPath } = scaffold()
    const out = capture()
    let asked = 0
    let released = false
    let finishLogin = (): void => {}
    const login = new Promise<void>((resolve) => (finishLogin = resolve))
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'antigravity-acp',
      methodId: 'oauth-personal',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () =>
        ({
          start: async () => {},
          authMethods: () => [{ id: 'oauth-personal', name: 'Log in with Google' }],
          authenticate: async () => login,
          stop: async () => {}
        }) as unknown as AcpHost,
      pasteAfterMs: 0,
      readLine: async (_question, signal) => {
        asked += 1
        // The operator is off in a browser: this question is answered by nobody.
        setTimeout(finishLogin, 10)
        return await new Promise<string>((resolve) =>
          signal?.addEventListener('abort', () => {
            released = true
            resolve('')
          })
        )
      }
    })
    expect(asked).toBe(1)
    expect(released).toBe(true)
    expect(out.text()).toContain('✓ antigravity-acp is logged in on this host.')
  })

  it('says so when a runtime advertises no login at all', async () => {
    const { root, configPath } = scaffold()
    const out = capture()
    await runAuth({
      root,
      configPath,
      out: out.stream,
      runtimeId: 'claude-acp',
      resolveCatalog: async () => catalog(),
      installed: (c) => c,
      hostFactory: () => fakeHost([])
    })
    expect(out.text()).toContain('advertises no login methods')
  })

  it('refuses a runtime that is not installed here', async () => {
    const { root, configPath } = scaffold()
    await expect(
      runAuth({
        root,
        configPath,
        out: capture().stream,
        runtimeId: 'absent',
        resolveCatalog: async () => catalog(),
        installed: (c) => c
      })
    ).rejects.toThrow(
      /runtime "absent" is not installed on this host\. Available: antigravity-acp, claude-acp, grok-build/
    )
  })
})

/** Drive the host options the command builds — `onAuthElicit` is what the agent's auth phase
 *  asks over, so the form answers are asserted through the very hook the agent calls. */
async function authElicit(
  params: CreateElicitationRequest,
  over: Parameters<typeof runAuth>[0] = {}
): Promise<CreateElicitationResponse | undefined> {
  const { root, configPath } = scaffold()
  let elicit: ((p: CreateElicitationRequest) => Promise<CreateElicitationResponse | undefined>) | undefined
  let answer: CreateElicitationResponse | undefined
  await runAuth({
    root,
    configPath,
    out: capture().stream,
    io: io(),
    runtimeId: 'claude-acp',
    methodId: 'oauth',
    resolveCatalog: async () => catalog(),
    installed: (c) => c,
    hostFactory: (_runtime, options) => {
      elicit = options?.onAuthElicit
      return {
        start: async () => {},
        authMethods: () => [{ id: 'oauth', name: 'Log in' }],
        authenticate: async () => {
          answer = await elicit!(params)
        },
        stop: async () => {}
      } as unknown as AcpHost
    },
    ...over
  })
  return answer
}

describe('runAuth: the auth phase’s form elicitations', () => {
  it('answers under the schema’s own property names and types', async () => {
    const answer = await authElicit(
      {
        mode: 'form',
        message: 'Which project should this credential belong to?',
        requestedSchema: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', title: 'Project id' },
            region: {
              type: 'string',
              title: 'Region',
              oneOf: [
                { const: 'us', title: 'United States' },
                { const: 'eu', title: 'Europe' }
              ]
            },
            sandbox: { type: 'boolean', title: 'Sandbox project' }
          }
        }
      } as unknown as CreateElicitationRequest,
      {
        readLine: async () => 'proj-42',
        // The enum and the boolean are PICKED from what the agent offered, never typed.
        pick: async (model) => model.rows()[0]!.id
      }
    )

    // A fixed {type,text} payload would answer none of these — the request asked for projectId.
    expect(answer).toEqual({
      action: 'accept',
      content: { projectId: 'proj-42', region: 'us', sandbox: true }
    })
  })

  it('declines when a required field is left unanswered', async () => {
    const answer = await authElicit(
      {
        mode: 'form',
        message: 'Which project?',
        requestedSchema: {
          type: 'object',
          required: ['projectId'],
          properties: {
            projectId: { type: 'string', title: 'Project id' },
            label: { type: 'string', title: 'Label' }
          }
        }
      } as unknown as CreateElicitationRequest,
      // Asked in schema order: the required field is skipped, the optional one answered — so the
      // form is refused by the required check, not by the "nothing typed at all" shortcut.
      {
        readLine: (() => {
          const typed = ['', 'staging']
          return async () => typed.shift()!
        })()
      }
    )
    expect(answer).toBeUndefined()
  })

  it('re-asks a value the field’s own schema refuses', async () => {
    const typed = ['not-a-number', '7']
    const answer = await authElicit(
      {
        mode: 'form',
        message: 'How many retries?',
        requestedSchema: {
          type: 'object',
          required: ['retries'],
          properties: { retries: { type: 'integer', title: 'Retries', minimum: 1, maximum: 10 } }
        }
      } as unknown as CreateElicitationRequest,
      { readLine: async () => typed.shift()! }
    )
    expect(answer).toEqual({ action: 'accept', content: { retries: 7 } })
  })

  it('declines a form whose required field this terminal cannot render', async () => {
    const answer = await authElicit(
      {
        mode: 'form',
        message: 'Upload the key file',
        requestedSchema: {
          type: 'object',
          required: ['keyFile'],
          properties: {
            keyFile: { type: 'object', title: 'Key file' },
            note: { type: 'string', title: 'Note' }
          }
        }
      } as unknown as CreateElicitationRequest,
      { readLine: async () => 'anything' }
    )
    // Half-answering a form is a lie about what the operator supplied.
    expect(answer).toBeUndefined()
  })

  it('accepts a URL-mode ask by showing the link, never by opening one', async () => {
    const out = capture()
    const answer = await authElicit(
      {
        mode: 'url',
        elicitationId: 'e-1',
        message: 'Sign in with Google',
        url: 'https://accounts.example.test/o/oauth2/auth?client_id=x'
      } as unknown as CreateElicitationRequest,
      { out: out.stream }
    )
    expect(answer).toEqual({ action: 'accept' })
    expect(out.text()).toContain('https://accounts.example.test/o/oauth2/auth?client_id=x')
  })
})
