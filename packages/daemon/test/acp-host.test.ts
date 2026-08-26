import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  AcpHost,
  claudeSessionMeta,
  shouldForwardUpdateDuringLoad,
  turnFailureCode,
  turnFailureReason
} from '../src/acp/acp-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs')
describe('AcpHost (against a fake ACP agent)', () => {
  it('initializes, creates a session, and streams an echoed reply', async () => {
    const updates: Array<{ sessionId: string; text: string }> = []
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: (sessionId, update) => {
          if (update.sessionUpdate === 'agent_message_chunk') {
            const c = (update as any).content
            if (c?.type === 'text') updates.push({ sessionId, text: c.text })
          }
        }
      }
    )
    await host.start()
    const sessionId = await host.newSession('/tmp')
    const res = await host.prompt(sessionId, [{ type: 'text', text: 'hi' }])
    expect(res.stopReason).toBe('end_turn')
    expect(updates).toContainEqual({ sessionId, text: 'echo:hi' })
    await host.stop()
  }, 15_000)

  // A runtime can advertise from inside `newSession()`: the host makes the session ownable and
  // then awaits its configuration round trips. Whatever the daemon needs in order to name that
  // session must therefore be handed over at the RAW response, before it is reachable.
  it('announces a new session id before the session becomes reachable', async () => {
    const host = new AcpHost({ command: process.execPath, args: [fakeAgent], env: [] }, { onUpdate: () => {} })
    await host.start()
    let reachableWhenAnnounced: boolean | undefined
    let announced: string | undefined
    const sessionId = await host.newSession('/tmp', [], undefined, undefined, [], (id) => {
      announced = id
      reachableWhenAnnounced = host.hasSession(id)
    })
    expect(announced).toBe(sessionId)
    expect(reachableWhenAnnounced).toBe(false)
    expect(host.hasSession(sessionId)).toBe(true)
    await host.stop()
  }, 15_000)

  it('applies and switches the composite Auto permission preset through independent selectors', async () => {
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: () => {},
        env: {
          AC_APPROVALS_REVIEWER: '1',
          AC_PERMISSION_MODES: 'read-only,agent,agent-full-access'
        },
        configPrefs: { permissionMode: 'agent', approvalsReviewer: 'auto_review' }
      }
    )
    await host.start()
    const sessionId = await host.newSession('/tmp')
    const mode = () => host.sessionConfigOptions(sessionId)?.find((option) => option.category === 'mode')
    const reviewer = () =>
      host.sessionConfigOptions(sessionId)?.find((option) => option.category === '_approvals_reviewer')
    expect(mode()?.currentValue).toBe('agent')
    expect(reviewer()?.currentValue).toBe('auto_review')

    await host.setSessionPermissionPreset(sessionId, 'agent-full-access')
    expect(mode()?.currentValue).toBe('agent-full-access')
    expect(reviewer()?.currentValue).toBe('user')

    await host.setSessionPermissionPreset(sessionId, 'agent:auto-review')
    expect(mode()?.currentValue).toBe('agent')
    expect(reviewer()?.currentValue).toBe('auto_review')
    await host.stop()
  }, 15_000)
})

describe('AcpHost.mcpCapabilities (MCP transports from initialize)', () => {
  it('is null before start, and coerces an absent capability block to all-false', async () => {
    const host = new AcpHost({ command: process.execPath, args: [fakeAgent], env: [] }, { onUpdate: () => {} })
    expect(host.mcpCapabilities()).toBeNull()
    await host.start()
    expect(host.mcpCapabilities()).toEqual({ http: false, sse: false })
    await host.stop()
  }, 15_000)

  it('captures the transports the agent advertised', async () => {
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      { onUpdate: () => {}, env: { AC_MCP_CAPS: 'http' } }
    )
    await host.start()
    expect(host.mcpCapabilities()).toEqual({ http: true, sse: false })
    await host.stop()
  }, 15_000)
})

describe('AcpHost additional workspace directories', () => {
  it('forwards them on new/load only when the agent advertises support', async () => {
    const cwd = '/tmp/repo/agents/node-operator'
    const repoRoot = '/tmp/repo'
    const supported = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: () => {},
        env: {
          AC_ADDITIONAL_DIRECTORIES: '1',
          AC_EXPECT_ADDITIONAL_DIRECTORIES: JSON.stringify([repoRoot]),
          AC_LOAD_UPDATES: '1'
        }
      }
    )
    await supported.start()
    await supported.newSession(cwd, [], undefined, undefined, [repoRoot])
    await supported.loadSession('persisted-session', cwd, [], undefined, undefined, [repoRoot])
    await supported.stop()

    const unsupported = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: () => {},
        env: { AC_EXPECT_ADDITIONAL_DIRECTORIES: '[]' }
      }
    )
    await unsupported.start()
    await unsupported.newSession(cwd, [], undefined, undefined, [repoRoot])
    await unsupported.stop()
  }, 15_000)
})

describe('AcpHost session/load update filtering', () => {
  it('forwards restored title metadata while suppressing replayed conversation output', async () => {
    const updates: string[] = []
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: (_sessionId, update) => updates.push(update.sessionUpdate),
        env: { AC_LOAD_UPDATES: '1' }
      }
    )
    await host.start()
    expect(host.loadSupported()).toBe(true)
    await host.loadSession('persisted-session', '/tmp')
    expect(updates).toEqual(['session_info_update'])
    await host.stop()
  }, 15_000)

  it('disables Auto-review before widening permissions on a restored session', async () => {
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        onUpdate: () => {},
        env: {
          AC_APPROVALS_REVIEWER: '1',
          AC_LOAD_APPROVALS_REVIEWER: 'auto_review',
          AC_LOAD_PERMISSION_MODE: 'agent',
          AC_LOAD_UPDATES: '1',
          AC_PERMISSION_MODES: 'read-only,agent,agent-full-access',
          AC_REJECT_AUTO_FULL_ACCESS: '1'
        },
        configPrefs: { permissionMode: 'agent-full-access', approvalsReviewer: 'user' }
      }
    )
    await host.start()
    await host.loadSession('persisted-auto-session', '/tmp')
    const options = host.sessionConfigOptions('persisted-auto-session')
    expect(options?.find((option) => option.category === 'mode')?.currentValue).toBe('agent-full-access')
    expect(options?.find((option) => option.category === '_approvals_reviewer')?.currentValue).toBe('user')
    await host.stop()
  }, 15_000)

  it('allows only latest-wins metadata through during load', () => {
    expect(shouldForwardUpdateDuringLoad({ sessionUpdate: 'session_info_update', title: 'Restored' })).toBe(true)
    expect(shouldForwardUpdateDuringLoad({ sessionUpdate: 'usage_update', used: 1, size: 10 } as any)).toBe(true)
    // The adapter advertises the command list AFTER a load's replay — the only one a resumed
    // session makes, so dropping it would leave the console blind until the next new session.
    expect(shouldForwardUpdateDuringLoad({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBe(
      true
    )
    expect(
      shouldForwardUpdateDuringLoad({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'history' }
      })
    ).toBe(false)
  })
})

describe('AcpHost.usesMetaSystemPrompt (system-prompt routing per runtime)', () => {
  const make = (command: string) => new AcpHost({ command, args: [], env: [] }, { onUpdate: () => {} })

  it('is true for Claude (rides _meta.systemPrompt), false otherwise (inlined block)', () => {
    expect(make('claude-code-acp').usesMetaSystemPrompt()).toBe(true)
    expect(make('codex-acp').usesMetaSystemPrompt()).toBe(false)
  })
})

describe('claudeSessionMeta (system prompt + memory index over _meta)', () => {
  it('returns undefined for a non-Claude runtime', () => {
    expect(claudeSessionMeta(undefined, false, 'seed', 'mem')).toBeUndefined()
  })

  it('omits systemPrompt when neither seed nor memory is set', () => {
    expect(claudeSessionMeta(undefined, true)?.systemPrompt).toBeUndefined()
  })

  it('carries the seed alone', () => {
    expect(claudeSessionMeta(undefined, true, 'be terse')?.systemPrompt).toEqual({ append: 'be terse' })
  })

  it('carries the memory index alone', () => {
    expect(claudeSessionMeta(undefined, true, undefined, '# Persistent memory\nidx')?.systemPrompt).toEqual({
      append: '# Persistent memory\nidx'
    })
  })

  it('joins seed then memory with a blank line', () => {
    expect(claudeSessionMeta(undefined, true, 'be terse', '# Persistent memory\nidx')?.systemPrompt).toEqual({
      append: 'be terse\n\n# Persistent memory\nidx'
    })
  })
})

describe('AcpHost.setSessionModel (mid-session model switch)', () => {
  it('applies an offered model to a live session and refreshes modelOptions; rejects bad inputs', async () => {
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      { onUpdate: () => {}, env: { AC_MODELS: 'model-a,model-b' } }
    )
    await host.start()
    const sid = await host.newSession('/tmp')
    expect(host.modelOptions()).toEqual({ current: 'model-a', models: ['model-a', 'model-b'] })

    // switch to an offered model → applied, options refreshed
    expect(await host.setSessionModel(sid, 'model-b')).toBe(true)
    expect(host.modelOptions()?.current).toBe('model-b')
    expect(host.modelOptions(sid)?.current).toBe('model-b')

    // A second session refreshes the host-global compatibility cache, but the
    // first session must retain its own selector for per-turn pricing/status.
    const sid2 = await host.newSession('/tmp')
    expect(host.modelOptions()?.current).toBe('model-a')
    expect(host.modelOptions(sid)?.current).toBe('model-b')
    expect(host.modelOptions(sid2)?.current).toBe('model-a')
    expect(host.modelOptions('s-unknown')).toBeNull()

    // already selected → no-op false; unoffered value → false; unknown session → false
    expect(await host.setSessionModel(sid, 'model-b')).toBe(false)
    expect(await host.setSessionModel(sid, 'nope')).toBe(false)
    expect(await host.setSessionModel('s-unknown', 'model-a')).toBe(false)
    await host.stop()
  }, 15_000)

  it('returns false when the runtime advertises no model selector', async () => {
    const host = new AcpHost({ command: process.execPath, args: [fakeAgent], env: [] }, { onUpdate: () => {} })
    await host.start()
    const sid = await host.newSession('/tmp')
    expect(host.modelOptions()).toBeNull()
    expect(await host.setSessionModel(sid, 'model-a')).toBe(false)
    await host.stop()
  }, 15_000)
})

const envEchoAgent = join(here, 'fixtures', 'env-echo-acp-agent.mjs')

it('injects opts.env into the spawned child process', async () => {
  const updates: string[] = []
  const host = new AcpHost(
    { command: process.execPath, args: [envEchoAgent], env: [] },
    {
      onUpdate: (_sid, update) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          const c = (update as any).content
          if (c?.type === 'text') updates.push(c.text)
        }
      },
      env: { AC_ECHO_VAR: 'injected-value' }
    }
  )
  await host.start()
  const sid = await host.newSession('/tmp')
  await host.prompt(sid, [{ type: 'text', text: 'go' }])
  expect(updates).toContain('env:injected-value')
  await host.stop()
}, 15_000)

it('can use an exact env without re-inheriting daemon variables', async () => {
  const updates: string[] = []
  const saved = process.env.AC_ECHO_VAR
  process.env.AC_ECHO_VAR = 'ambient-value'
  try {
    const host = new AcpHost(
      { command: process.execPath, args: [envEchoAgent], env: [] },
      {
        onUpdate: (_sid, update) => {
          if (update.sessionUpdate !== 'agent_message_chunk') return
          const content = (update as { content?: { type?: string; text?: string } }).content
          if (content?.type === 'text' && content.text) updates.push(content.text)
        },
        env: { AC_ECHO_NAME: 'AC_ECHO_VAR' },
        inheritProcessEnv: false
      }
    )
    await host.start()
    const sid = await host.newSession('/tmp')
    await host.prompt(sid, [{ type: 'text', text: 'go' }])
    expect(updates).toContain('env:')
    await host.stop()
  } finally {
    if (saved === undefined) delete process.env.AC_ECHO_VAR
    else process.env.AC_ECHO_VAR = saved
  }
}, 15_000)

async function runIsolatedFixture(
  runtimeId: string,
  name: string,
  value: string,
  log?: { info: (message: string) => void; warn: (message: string) => void },
  isolateAccountApps?: boolean
): Promise<string[]> {
  const updates: string[] = []
  const host = new AcpHost(
    // Neutral "agent" marker arg; account-app isolation now keys off runtimeId, so
    // any appended flag lands after it in argv.
    { command: process.execPath, args: [envEchoAgent, 'agent'], env: [{ name, value }] },
    {
      onUpdate: (_sid, update) => {
        if (update.sessionUpdate !== 'agent_message_chunk') return
        const content = (update as { content?: { type?: string; text?: string } }).content
        if (content?.type === 'text' && content.text) updates.push(content.text)
      },
      env: { AC_ECHO_NAME: name, [name]: value },
      runtimeId,
      isolateAccountApps,
      ...(log
        ? {
            log: {
              trace: () => {},
              debug: () => {},
              info: log.info,
              warn: log.warn,
              error: () => {}
            }
          }
        : {})
    }
  )
  await host.start()
  const sid = await host.newSession('/tmp')
  await host.prompt(sid, [{ type: 'text', text: 'go' }])
  await host.stop()
  return updates
}

describe('AcpHost — account-bound app isolation', () => {
  it('forces Codex apps off in the spawned process after all caller env is merged', async () => {
    const raw = JSON.stringify({ model: 'gpt-test', features: { fast_mode: true, apps: true } })
    const out = await runIsolatedFixture('codex-acp', 'CODEX_CONFIG', raw)

    const echoed = out.find((line) => line.startsWith('env:'))?.slice('env:'.length)
    expect(JSON.parse(echoed ?? '')).toEqual({
      model: 'gpt-test',
      features: { fast_mode: true, apps: false }
    })
  }, 15_000)

  it('warns and replaces unsafe CODEX_CONFIG without blocking child startup', async () => {
    const warns: string[] = []
    const out = await runIsolatedFixture('codex-acp', 'CODEX_CONFIG', 'not-json', {
      info: () => {},
      warn: (message) => warns.push(message)
    })

    const echoed = out.find((line) => line.startsWith('env:'))?.slice('env:'.length)
    expect(JSON.parse(echoed ?? '')).toEqual({ features: { apps: false } })
    expect(warns.join('\n')).toContain('ignoring unsafe inherited CODEX_CONFIG')
  }, 15_000)

  it('forces Claude.ai MCP servers off in the spawned process', async () => {
    const out = await runIsolatedFixture('claude-acp', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'true')
    expect(out).toContain('env:false')
  }, 15_000)

  it('appends Copilot --disable-builtin-mcps to the spawned argv', async () => {
    const out = await runIsolatedFixture('github-copilot-cli', 'ARGV', 'x')
    const argv = JSON.parse(out.find((line) => line.startsWith('argv:'))?.slice('argv:'.length) ?? '[]')
    expect(argv).toContain('--disable-builtin-mcps')
  }, 15_000)

  it('preserves Codex account apps when the daemon explicitly opts out', async () => {
    const warns: string[] = []
    const raw = JSON.stringify({ model: 'gpt-test', features: { apps: true } })
    const out = await runIsolatedFixture(
      'codex-acp',
      'CODEX_CONFIG',
      raw,
      { info: () => {}, warn: (message) => warns.push(message) },
      false
    )

    const echoed = out.find((line) => line.startsWith('env:'))?.slice('env:'.length)
    expect(JSON.parse(echoed ?? '')).toEqual({ model: 'gpt-test', features: { apps: true } })
    expect(warns.join('\n')).toContain('account-app isolation disabled by daemon config')
  }, 15_000)

  it('preserves Copilot built-in MCPs when the daemon explicitly opts out', async () => {
    const out = await runIsolatedFixture('github-copilot-cli', 'ARGV', 'x', undefined, false)
    const argv = JSON.parse(out.find((line) => line.startsWith('argv:'))?.slice('argv:'.length) ?? '[]')
    expect(argv).not.toContain('--disable-builtin-mcps')
  }, 15_000)

  it('warns for a known account-app runtime with no safe isolation switch when opted out', async () => {
    const warns: string[] = []
    await runIsolatedFixture(
      'auggie',
      'AC_ECHO_VAR',
      'ok',
      { info: () => {}, warn: (message) => warns.push(message) },
      false
    )
    expect(warns.join('\n')).toContain('account-app isolation disabled by daemon config for auggie')
    expect(warns.join('\n')).toContain('no narrow switch')
  }, 15_000)

  it('does not warn for a runtime with no account-connector concept', async () => {
    const warns: string[] = []
    await runIsolatedFixture('gemini', 'AC_ECHO_VAR', 'ok', {
      info: () => {},
      warn: (message) => warns.push(message)
    })
    expect(warns).toEqual([])
  }, 15_000)

  it('warns when the runtime is unrecognized', async () => {
    const warns: string[] = []
    await runIsolatedFixture('some-new-agent', 'AC_ECHO_VAR', 'ok', {
      info: () => {},
      warn: (message) => warns.push(message)
    })
    expect(warns.join('\n')).toContain('not verified')
  }, 15_000)
})

const claudeAgent = join(here, 'fixtures', 'claude-env-echo-acp-agent.mjs')

// Run a claude-fixture host (its path contains "claude" ⇒ AcpHost treats it as a
// Claude runtime) and capture what it echoes for CLAUDE_CODE_EXECUTABLE.
async function runClaudeHost(env: Record<string, string>): Promise<string[]> {
  const out: string[] = []
  const host = new AcpHost(
    { command: process.execPath, args: [claudeAgent], env: [] },
    {
      onUpdate: (_sid, update) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          const c = (update as { content?: { type?: string; text?: string } }).content
          if (c?.type === 'text' && c.text) out.push(c.text)
        }
      },
      env
    }
  )
  await host.start()
  const sid = await host.newSession('/tmp')
  await host.prompt(sid, [{ type: 'text', text: 'go' }])
  await host.stop()
  return out
}

describe('AcpHost — auto-inject CLAUDE_CODE_EXECUTABLE for a Claude runtime', () => {
  it('sets it from a `claude` on PATH when unset', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'ac-claudebin-'))
    const fakeClaude = join(bin, 'claude')
    writeFileSync(fakeClaude, '#!/bin/sh\n')
    chmodSync(fakeClaude, 0o755)
    const saved = process.env.CLAUDE_CODE_EXECUTABLE
    delete process.env.CLAUDE_CODE_EXECUTABLE
    try {
      // PATH (merged after process.env) points only at our fake claude.
      const out = await runClaudeHost({ PATH: bin })
      expect(out).toContain(`claude_exec:${fakeClaude}`)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE
      else process.env.CLAUDE_CODE_EXECUTABLE = saved
    }
  }, 15_000)

  it('does NOT override an already-set CLAUDE_CODE_EXECUTABLE', async () => {
    const out = await runClaudeHost({ CLAUDE_CODE_EXECUTABLE: '/custom/claude', PATH: '/nonexistent' })
    expect(out).toContain('claude_exec:/custom/claude')
  }, 15_000)
})

describe('turnFailureReason (actionable message from a failed ACP request)', () => {
  const LIMIT =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:01 PM."

  it('prefers data.message over a generic JSON-RPC title (codex-acp quota exhaustion)', () => {
    // Exactly what codex-acp rejects session/prompt with when Codex is out of usage.
    const err = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { message: LIMIT, codexErrorInfo: 'usageLimitExceeded' }
    })
    expect(turnFailureReason(err)).toBe(LIMIT)
  })

  it('keeps a specific message that already contains the detail (authRequired with additionalMessage)', () => {
    const err = Object.assign(new Error(`Authentication required: ${LIMIT}`), {
      code: -32000,
      data: { message: LIMIT }
    })
    expect(turnFailureReason(err)).toBe(`Authentication required: ${LIMIT}`)
  })

  it('appends a distinct detail to a non-generic message', () => {
    const err = Object.assign(new Error('turn aborted'), { code: -32603, data: { message: 'backend unreachable' } })
    expect(turnFailureReason(err)).toBe('turn aborted: backend unreachable')
  })

  it('falls back to the plain Error message when there is no data', () => {
    expect(turnFailureReason(new Error('spawn claude ENOENT'))).toBe('spawn claude ENOENT')
  })
})

describe('turnFailureCode (normalized non-actionable provider failures)', () => {
  it.each([
    {
      name: 'codex-acp structured usage code',
      error: Object.assign(new Error('Internal error'), {
        code: -32603,
        data: { codexErrorInfo: 'usageLimitExceeded' }
      })
    },
    {
      name: 'OpenAI-compatible nested quota code',
      error: Object.assign(new Error('request failed'), {
        data: { error: { type: 'insufficient_quota' } }
      })
    },
    {
      name: 'Codex usage text',
      error: Object.assign(new Error('Internal error'), {
        data: { message: "You've hit your usage limit. Purchase more credits or try again at 7:01 PM." }
      })
    },
    {
      name: 'Claude reset text',
      error: new Error("You've hit your limit · resets 2pm (America/Los_Angeles)")
    },
    {
      name: 'provider credit exhaustion text',
      error: { error: { message: 'Credit balance is too low to access the Anthropic API' } }
    },
    {
      // Observed live 2026-08-21: every review turn on the org died in under a second, and this
      // wording reached neither the quota codes nor the usage-limit patterns, so the Check said
      // only "Review could not be completed" while the real cause sat in the daemon log.
      name: 'Claude org spend limit text',
      error: Object.assign(
        new Error(
          "Internal error: You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit"
        ),
        { code: -32603, data: { errorKind: 'rate_limit' } }
      )
    },
    {
      name: 'spend limit reached text',
      error: { data: { message: 'Your monthly spend limit has been reached.' } }
    }
  ])('classifies $name as provider_quota_exhausted', ({ error }) => {
    expect(turnFailureCode(error)).toBe('provider_quota_exhausted')
  })

  it('classifies an expired unrefreshable OAuth session as provider_auth_required', () => {
    // Observed live from claude-agent-acp 0.59.0 with an expired-but-present
    // OAuth credential (agent private HOME seeded long ago): initialize and
    // session/new succeed, the prompt rejects -32603 with this exact message.
    const error = Object.assign(
      new Error('Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'),
      { code: -32603 }
    )
    expect(turnFailureCode(error)).toBe('provider_auth_required')
  })

  it('classifies a revoked refresh token as provider_auth_required', () => {
    const error = Object.assign(new Error('Authentication required'), {
      data: {
        message:
          'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'
      }
    })
    expect(turnFailureCode(error)).toBe('provider_auth_required')
  })

  it.each([
    new Error('spawn claude ENOENT'),
    { code: 'rate_limit_error', message: 'Rate limit exceeded; retry in 20 seconds' },
    // An adapter's `rate_limit` error kind is transient on its own: only the message promotes.
    { message: 'Rate limit exceeded; retry in 20 seconds', data: { errorKind: 'rate_limit' } },
    { data: { error: { type: 'overloaded_error', message: 'Service temporarily overloaded' } } },
    Object.assign(new Error('Authentication required'), { data: { message: 'Please sign in again' } })
  ])('keeps non-quota failures as turn_failed', (error) => {
    expect(turnFailureCode(error)).toBe('turn_failed')
  })
})

describe('AcpHost.stop', () => {
  it('resolves promptly when the child already exited on its own (e.g. terminal Ctrl-C hit the process group)', async () => {
    const host = new AcpHost({ command: process.execPath, args: [fakeAgent], env: [] }, { onUpdate: () => {} })
    await host.start()
    // Kill the child out from under the host — the terminal delivering SIGINT to
    // the whole foreground process group does exactly this — and wait until its
    // 'exit' has actually been emitted, so stop() runs against a reaped child.
    // The process handle now lives in the local spawn driver's launched target.
    const child = (host as unknown as { spawned: { child: import('node:child_process').ChildProcess } }).spawned.child
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGKILL')
    })
    const t0 = Date.now()
    await host.stop()
    // The regression hung here forever (once('exit') never re-fires); well under
    // the 5s SIGTERM deadline proves the pre-exited guard took the early return.
    expect(Date.now() - t0).toBeLessThan(1000)
  }, 15_000)

  // Windows has no POSIX signals, so there is no SIGTERM to ignore and no SIGKILL to escalate to.
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when the child ignores SIGTERM',
    async () => {
      const warns: string[] = []
      const host = new AcpHost(
        { command: process.execPath, args: [fakeAgent], env: [] },
        {
          onUpdate: () => {},
          env: { AC_IGNORE_SIGTERM: '1' },
          log: { trace: () => {}, debug: () => {}, info: () => {}, warn: (m: string) => warns.push(m), error: () => {} }
        }
      )
      await host.start()
      await host.stop(200)
      expect(warns.join('\n')).toContain('ignored SIGTERM')
    },
    15_000
  )
})
