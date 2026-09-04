import { describe, it, expect } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  claudeSessionMeta,
  effortOptionsFrom,
  fastOptionFrom,
  modelOptionsFrom,
  permissionModeOptionsFrom,
  planConfigSelection,
  SDK_LIFECYCLE_FILTERS
} from '../src/acp/acp-host.js'
import { CLAUDE_DISALLOWED_BUILTIN_TOOLS } from '../src/runtime-defs/claude-runtime.js'

/** configOptions as claude-acp advertises them: mode + model + effort selects.
 *  The effort values are the runtime's real `thought_level` enum, verified against
 *  @agentclientprotocol/claude-agent-acp@0.55.0 (Opus 4.8): default/low/medium/
 *  high/xhigh/max — note there is no "ultracode" value (that rides `_meta`). */
const claudeLike = (over: { model?: string; effort?: string } = {}): SessionConfigOption[] => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'acceptEdits', name: 'Accept Edits' }
    ]
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: over.model ?? 'claude-opus-4-8',
    options: [
      { value: 'claude-opus-4-8', name: 'Opus 4.8' },
      { value: 'claude-sonnet-5', name: 'Sonnet 5' }
    ]
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: over.effort ?? 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Xhigh' },
      { value: 'max', name: 'Max' }
    ]
  }
]

describe('planConfigSelection', () => {
  it('plans a runtime permission mode switch via the mode category', () => {
    expect(planConfigSelection(claudeLike(), 'mode', 'acceptEdits')).toEqual({
      configId: 'mode',
      value: 'acceptEdits'
    })
  })

  it('plans a set_config_option call for an offered effort level', () => {
    expect(planConfigSelection(claudeLike(), 'thought_level', 'high')).toEqual({ configId: 'effort', value: 'high' })
  })

  it('plans a model switch via the model category', () => {
    expect(planConfigSelection(claudeLike(), 'model', 'claude-sonnet-5')).toEqual({
      configId: 'model',
      value: 'claude-sonnet-5'
    })
  })

  it('flattens grouped select options', () => {
    const grouped: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { group: 'g1', name: 'G1', options: [{ value: 'a', name: 'A' }] },
          { group: 'g2', name: 'G2', options: [{ value: 'b', name: 'B' }] }
        ]
      }
    ]
    expect(planConfigSelection(grouped, 'model', 'b')).toEqual({ configId: 'model', value: 'b' })
  })

  it('skips when the runtime advertises no selector for the category', () => {
    expect(planConfigSelection([], 'thought_level', 'high')).toHaveProperty('skip')
    expect(planConfigSelection(null, 'thought_level', 'high')).toHaveProperty('skip')
    expect(planConfigSelection(undefined, 'model', 'x')).toHaveProperty('skip')
  })

  it('skips an unoffered value and names the valid ones', () => {
    // "ultracode" is exactly our sentinel — it is NOT a thought_level value, so it
    // must skip here (the daemon routes it via `_meta`, see claudeSessionMeta).
    const plan = planConfigSelection(claudeLike(), 'thought_level', 'ultracode')
    expect(plan).toHaveProperty('skip')
    expect((plan as { skip: string }).skip).toContain('default, low, medium, high, xhigh, max')
  })

  it('skips when the value is already current', () => {
    expect(planConfigSelection(claudeLike({ effort: 'high' }), 'thought_level', 'high')).toHaveProperty('skip')
  })

  it('ignores non-select options in the category', () => {
    const boolOnly: SessionConfigOption[] = [
      { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: false }
    ]
    expect(planConfigSelection(boolOnly, 'model_config', 'on')).toHaveProperty('skip')
  })

  // Fast mode as claude-acp (id "fast") / codex-acp (id "fast-mode") advertise it
  // to clients WITHOUT the boolean-config capability: an on/off select tagged
  // `category: "model_config"`, present only when the model supports fast mode.
  it('plans the fast-mode toggle via the model_config category (select fallback)', () => {
    const fastSelect = (id: string, current: 'on' | 'off'): SessionConfigOption[] => [
      {
        id,
        name: 'Fast mode',
        category: 'model_config',
        type: 'select',
        currentValue: current,
        options: [
          { value: 'on', name: 'On' },
          { value: 'off', name: 'Off' }
        ]
      }
    ]
    expect(planConfigSelection(fastSelect('fast', 'off'), 'model_config', 'on')).toEqual({
      configId: 'fast',
      value: 'on'
    })
    expect(planConfigSelection(fastSelect('fast-mode', 'on'), 'model_config', 'off')).toEqual({
      configId: 'fast-mode',
      value: 'off'
    })
    // already current / model without fast support (no option) → skip
    expect(planConfigSelection(fastSelect('fast', 'on'), 'model_config', 'on')).toHaveProperty('skip')
    expect(planConfigSelection(claudeLike(), 'model_config', 'on')).toHaveProperty('skip')
  })
})

describe('modelOptionsFrom', () => {
  it('reflects the post-apply current model', () => {
    expect(modelOptionsFrom(claudeLike({ model: 'claude-sonnet-5' }))).toEqual({
      current: 'claude-sonnet-5',
      models: ['claude-opus-4-8', 'claude-sonnet-5']
    })
  })
})

describe('permissionModeOptionsFrom', () => {
  it('reflects the current runtime permission mode + advertised modes', () => {
    expect(permissionModeOptionsFrom(claudeLike())).toEqual({
      current: 'default',
      modes: ['default', 'acceptEdits']
    })
  })

  it('returns null when the runtime advertises no mode selector', () => {
    expect(permissionModeOptionsFrom([])).toBeNull()
    expect(permissionModeOptionsFrom(null)).toBeNull()
    expect(permissionModeOptionsFrom(undefined)).toBeNull()
  })
})

describe('effortOptionsFrom', () => {
  it('reflects the current effort + advertised levels, appending synthetic ultracode on Claude', () => {
    expect(effortOptionsFrom(claudeLike({ effort: 'high' }), true)).toEqual({
      current: 'high',
      // `max` is already advertised so it isn't duplicated; only `ultracode` is appended.
      efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
    })
  })

  it('does not append synthetic levels off a Claude runtime', () => {
    expect(effortOptionsFrom(claudeLike(), false)).toEqual({
      current: 'default',
      efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max']
    })
  })

  it('returns null when the current model has no thought_level select (e.g. Haiku — no effort support)', () => {
    // Effort is per-model: no advertised selector ⇒ no picker, and we do NOT fabricate
    // synthetic max/ultracode for a model that lacks effort entirely (the Haiku bug).
    expect(effortOptionsFrom([], true)).toBeNull()
    expect(effortOptionsFrom([], false)).toBeNull()
    expect(effortOptionsFrom(null, true)).toBeNull()
    expect(effortOptionsFrom(undefined, false)).toBeNull()
  })
})

describe('fastOptionFrom', () => {
  const fastSelect = (current: 'on' | 'off'): SessionConfigOption[] => [
    {
      id: 'fast',
      name: 'Fast mode',
      category: 'model_config',
      type: 'select',
      currentValue: current,
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' }
      ]
    }
  ]

  it('reads the on/off current value', () => {
    expect(fastOptionFrom(fastSelect('on'))).toEqual({ current: true })
    expect(fastOptionFrom(fastSelect('off'))).toEqual({ current: false })
  })

  it('returns null when the current model advertises no fast toggle', () => {
    expect(fastOptionFrom(claudeLike())).toBeNull()
    expect(fastOptionFrom([])).toBeNull()
    expect(fastOptionFrom(undefined)).toBeNull()
  })
})

describe('claudeSessionMeta', () => {
  // Recent models default thinking.display to "omitted" (signature-only blocks,
  // empty text) — without this the wrapper never emits agent_thought_chunk and the
  // transcript loses its reasoning rows.
  const THINKING = { type: 'adaptive', display: 'summarized' }
  // Every Claude session also opts into the filtered SDK-lifecycle feed (the
  // background-task lease) and the #998 built-in messaging-tool suppression.
  // `options` is the only per-call-varying part.
  const cc = (options: Record<string, unknown>) => ({
    claudeCode: {
      options: { disallowedTools: CLAUDE_DISALLOWED_BUILTIN_TOOLS, ...options },
      emitRawSDKMessages: SDK_LIFECYCLE_FILTERS
    }
  })

  it('always disallows the built-in agent-teams SendMessage (#800 collision / #998 exfiltration)', () => {
    expect(claudeSessionMeta(undefined, true)?.claudeCode.options.disallowedTools).toEqual(['SendMessage'])
  })

  it('always requests summarized thinking on a Claude runtime', () => {
    expect(claudeSessionMeta(undefined, true)).toEqual(cc({ thinking: THINKING }))
    expect(claudeSessionMeta('xhigh', true)).toEqual(cc({ thinking: THINKING }))
    expect(claudeSessionMeta('max', true)).toEqual(cc({ thinking: THINKING }))
    expect(claudeSessionMeta('high', true)).toEqual(cc({ thinking: THINKING }))
  })

  it('adds the ultracode flag settings for effort "ultracode"', () => {
    expect(claudeSessionMeta('ultracode', true)).toEqual(
      cc({ thinking: THINKING, settings: { ultracode: true, enableWorkflows: true } })
    )
  })

  it('enables the native Claude sandbox only behind an outer AgentConnect sandbox', () => {
    const credentialRoot = '/host/.claude/agentconnect-auth'
    const protectedSettings = {
      modelOverrides: { sonnet: 'bedrock/sonnet' },
      availableModels: ['sonnet'],
      env: {
        ANTHROPIC_CONFIG_DIR: '/agent/.agentconnect/runtime-policy/claude-profile-disabled',
        ANTHROPIC_PROFILE: 'agentconnect-disabled'
      }
    }
    const sandbox = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        allowAllUnixSockets: false
      },
      filesystem: {
        denyRead: [credentialRoot],
        denyWrite: [credentialRoot]
      },
      credentials: {
        files: [{ path: credentialRoot, mode: 'deny' }],
        envVars: [
          { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
          { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' },
          { name: 'ANTHROPIC_IDENTITY_TOKEN', mode: 'deny' },
          { name: 'ANTHROPIC_IDENTITY_TOKEN_FILE', mode: 'deny' },
          { name: 'ANTHROPIC_CONFIG_DIR', mode: 'deny' },
          { name: 'ANTHROPIC_PROFILE', mode: 'deny' },
          { name: 'ANTHROPIC_CUSTOM_HEADERS', mode: 'deny' },
          { name: 'ANTHROPIC_AWS_API_KEY', mode: 'deny' },
          { name: 'ANTHROPIC_FOUNDRY_API_KEY', mode: 'deny' },
          { name: 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', mode: 'deny' },
          { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' },
          { name: 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', mode: 'deny' },
          { name: 'AWS_ACCESS_KEY_ID', mode: 'deny' },
          { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' },
          { name: 'AWS_SESSION_TOKEN', mode: 'deny' },
          { name: 'AWS_BEARER_TOKEN_BEDROCK', mode: 'deny' },
          { name: 'AWS_CONTAINER_AUTHORIZATION_TOKEN', mode: 'deny' },
          { name: 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', mode: 'deny' },
          { name: 'AWS_CONTAINER_CREDENTIALS_FULL_URI', mode: 'deny' },
          { name: 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', mode: 'deny' },
          { name: 'AWS_EC2_METADATA_SERVICE_ENDPOINT', mode: 'deny' },
          { name: 'AWS_CONFIG_FILE', mode: 'deny' },
          { name: 'AWS_SHARED_CREDENTIALS_FILE', mode: 'deny' },
          { name: 'AWS_WEB_IDENTITY_TOKEN_FILE', mode: 'deny' },
          { name: 'CLOUDSDK_AUTH_ACCESS_TOKEN', mode: 'deny' },
          { name: 'GOOGLE_APPLICATION_CREDENTIALS', mode: 'deny' }
        ]
      }
    }

    expect(claudeSessionMeta(undefined, true, undefined, undefined, [credentialRoot], protectedSettings)).toEqual(
      cc({ thinking: THINKING, sandbox, settings: protectedSettings })
    )
    expect(
      claudeSessionMeta(undefined, true, undefined, undefined, [credentialRoot], protectedSettings, true)?.claudeCode
        .options.sandbox?.network.allowAllUnixSockets
    ).toBe(true)
    expect(claudeSessionMeta('ultracode', true, undefined, undefined, [credentialRoot], protectedSettings)).toEqual(
      cc({
        thinking: THINKING,
        sandbox,
        settings: { ...protectedSettings, ultracode: true, enableWorkflows: true }
      })
    )
    // An empty array still means an outer sandbox is active; undefined means it
    // is not, and must preserve the existing unsandboxed Claude behavior.
    expect(claudeSessionMeta(undefined, true, undefined, undefined, [], protectedSettings)).toEqual(
      cc({
        thinking: THINKING,
        settings: protectedSettings,
        sandbox: {
          ...sandbox,
          filesystem: { ...sandbox.filesystem, denyRead: [], denyWrite: [] },
          credentials: { ...sandbox.credentials, files: [] }
        }
      })
    )
    expect(claudeSessionMeta(undefined, true)).toEqual(cc({ thinking: THINKING }))
    // An operator-declared shared store is reopened for model-authored Bash too; the credential roots stay denied.
    expect(
      claudeSessionMeta(undefined, true, undefined, undefined, [credentialRoot], undefined, false, [], ['/host/store'])
        ?.claudeCode.options.sandbox?.filesystem
    ).toEqual({ allowWrite: ['/host/store'], denyRead: [credentialRoot], denyWrite: [credentialRoot] })
  })

  it('returns undefined off a Claude runtime (the _meta is claude-acp-specific)', () => {
    expect(claudeSessionMeta(undefined, false)).toBeUndefined()
    expect(claudeSessionMeta('ultracode', false)).toBeUndefined()
    expect(claudeSessionMeta(undefined, false, undefined, undefined, ['/credential'])).toBeUndefined()
  })

  it('appends the system prompt (sibling of claudeCode) when one is set', () => {
    expect(claudeSessionMeta(undefined, true, 'you are an obsidian assistant')).toEqual({
      ...cc({ thinking: THINKING }),
      systemPrompt: { append: 'you are an obsidian assistant' }
    })
  })

  it('omits systemPrompt when the seed is empty/undefined', () => {
    expect(claudeSessionMeta('high', true, undefined)).toEqual(cc({ thinking: THINKING }))
    expect(claudeSessionMeta('high', true, '')).toEqual(cc({ thinking: THINKING }))
  })

  it('never sends a system prompt off a Claude runtime', () => {
    expect(claudeSessionMeta(undefined, false, 'ignored')).toBeUndefined()
  })
})
