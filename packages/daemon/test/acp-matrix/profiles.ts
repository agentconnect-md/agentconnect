// Agent profiles for the daemon↔ACP integration matrix.
//
// Each profile is one real ACP-registry agent (see cdn.agentclientprotocol.com
// registry) rendered as a DECLARATIVE capability archetype: the `scenario` is fed to
// test/fixtures/scriptable-acp-agent.mjs via AC_SCENARIO, and `caps` is the surface
// the daemon's AcpHost should observe. The capability shapes span the ACP optional-
// capability space (loadSession, MCP transports, the model/mode/effort/fast config
// selectors) so the matrix exercises every branch of the daemon's ACP handling; they
// are a reviewable test contract, NOT a captured golden of each vendor's live output.
//
// Adding a runtime = one entry here + its column falls out of support-matrix.ts.
// Every entry MUST also classify provider compatibility in `memory`: the separate
// runtime-memory contract test compares it to the production policy registry, so a
// new harness cannot land without an explicit managed/none/native decision.
import type { RuntimeDef } from '../../src/config/config-schema.js'
import type { RuntimeMemoryCapabilities } from '../../src/memory/runtime/capabilities.js'

/** ACP `configOptions` select entry (see acp-host.ts modelOptionsFrom / permissionModeOptionsFrom). */
export interface SelectOption {
  id: string
  category: 'model' | 'mode' | 'thought_level' | 'model_config'
  type: 'select'
  currentValue: string
  options: Array<{ value: string; name?: string }>
}

const select = (
  id: SelectOption['id'],
  category: SelectOption['category'],
  values: string[],
  current = values[0]!
): SelectOption => ({
  id,
  category,
  type: 'select',
  currentValue: current,
  options: values.map((v) => ({ value: v, name: v }))
})

/** The JSON scenario the fixture reads. */
export interface Scenario {
  agentCapabilities?: {
    loadSession?: boolean
    mcpCapabilities?: { http?: boolean; sse?: boolean }
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  }
  configOptions?: SelectOption[]
  prompt?: {
    updates?: unknown[]
    usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
    stopReason?: string
    error?: { code?: number; message?: string }
    requestPermission?: { options: Array<{ optionId: string; name: string; kind: string }>; toolCall?: unknown }
    elicit?: Record<string, unknown>
    /** Echo back the `_meta.systemPrompt.append` the daemon sent at session/new (memory feature). */
    echoSysMeta?: boolean
  }
  load?: { replay?: unknown[]; title?: string }
  ignoreSigterm?: boolean
}

/** What the daemon should observe once initialize + session/new complete. */
export interface ExpectedCaps {
  loadSession: boolean
  mcp: { http: boolean; sse: boolean }
  promptImage: boolean
  /** Expected `modelOptions().models`, or null when no model selector is advertised. */
  models: string[] | null
  /** Expected `permissionModeOptions().modes`, or null when no mode selector. */
  permissionModes: string[] | null
  /** Whether `prompt()` should return a `usage` object. */
  usage: boolean
  /** Audited identity accepted by the daemon's exact bundled skills CLI. */
  skillsAgentId: string | null
}

export interface Profile {
  /** Local id used in the matrix + as the config runtime name. */
  id: string
  /** The ACP-registry id this archetype stands in for. */
  registryId: string
  /** Whether the daemon treats it as a Claude runtime (command contains "claude"). */
  claudeRuntime?: boolean
  /** Real registry-style launch signature + the reviewed provider capability contract. */
  memory: { runtime: RuntimeDef; expected: RuntimeMemoryCapabilities }
  scenario: Scenario
  caps: ExpectedCaps
}

const usage = { used: 1200, size: 200_000, cost: { amount: 0.0123, currency: 'USD' } }
const runtime = (command: string, args: string[] = []): RuntimeDef => ({ command, args, env: [] })

export const PROFILES: Profile[] = [
  {
    // Full-featured: loadSession + model/effort/mode/fast selectors + usage & cost.
    id: 'claude',
    registryId: 'claude-acp',
    claudeRuntime: true,
    memory: {
      runtime: runtime('npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.62.0']),
      expected: { managed: true, none: true, native: true }
    },
    scenario: {
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: true }
      },
      configOptions: [
        select('model', 'model', ['opus', 'sonnet', 'haiku']),
        select('thought_level', 'thought_level', ['low', 'medium', 'high']),
        select('mode', 'mode', ['default', 'plan']),
        select('model_config', 'model_config', ['on', 'off'], 'off')
      ],
      prompt: { updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '$INPUT' } }], usage }
    },
    caps: {
      loadSession: true,
      mcp: { http: true, sse: false },
      promptImage: true,
      models: ['opus', 'sonnet', 'haiku'],
      permissionModes: ['default', 'plan'],
      usage: true,
      skillsAgentId: 'claude-code'
    }
  },
  {
    // Codex: no loadSession, http+sse MCP, its own agent/read-only mode vocabulary, usage & cost.
    id: 'codex',
    registryId: 'codex-acp',
    memory: {
      runtime: runtime('npx', ['-y', '@agentclientprotocol/codex-acp@1.1.7']),
      expected: { managed: true, none: true, native: true }
    },
    scenario: {
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: true } },
      configOptions: [
        select('model', 'model', ['gpt-5-codex', 'gpt-5']),
        select('mode', 'mode', ['agent', 'read-only'])
      ],
      prompt: { usage }
    },
    caps: {
      loadSession: false,
      mcp: { http: true, sse: true },
      promptImage: false,
      models: ['gpt-5-codex', 'gpt-5'],
      permissionModes: ['agent', 'read-only'],
      usage: true,
      skillsAgentId: 'codex'
    }
  },
  {
    // pi: bare agent — zero advertised capabilities, no selectors, no usage.
    id: 'pi',
    registryId: 'pi-acp',
    memory: {
      runtime: runtime('npx', ['-y', 'pi-acp@0.0.32']),
      expected: { managed: true, none: false, native: false }
    },
    scenario: { agentCapabilities: {}, prompt: {} },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: null,
      permissionModes: null,
      usage: false,
      skillsAgentId: 'pi'
    }
  },
  {
    // Cursor: loadSession + model selector + http MCP, but no permission-mode selector.
    id: 'cursor',
    registryId: 'cursor',
    memory: {
      runtime: runtime('./dist-package/cursor-agent'),
      expected: { managed: true, none: false, native: false }
    },
    scenario: {
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
      configOptions: [select('model', 'model', ['cursor-fast', 'cursor-max'])],
      prompt: { usage: { used: 500, size: 100_000 } }
    },
    caps: {
      loadSession: true,
      mcp: { http: true, sse: false },
      promptImage: false,
      models: ['cursor-fast', 'cursor-max'],
      permissionModes: null,
      usage: true,
      skillsAgentId: 'cursor'
    }
  },
  {
    // OpenCode: loadSession + http/sse MCP + model & its own build/plan mode vocab.
    id: 'opencode',
    registryId: 'opencode',
    memory: {
      runtime: runtime('./opencode'),
      expected: { managed: true, none: false, native: false }
    },
    scenario: {
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
      configOptions: [
        select('model', 'model', ['anthropic/sonnet', 'openai/gpt-5']),
        select('mode', 'mode', ['build', 'plan'])
      ]
    },
    caps: {
      loadSession: true,
      mcp: { http: true, sse: true },
      promptImage: false,
      models: ['anthropic/sonnet', 'openai/gpt-5'],
      permissionModes: ['build', 'plan'],
      usage: false,
      skillsAgentId: 'opencode'
    }
  },
  {
    // Cline: model selector only, no loadSession, no MCP, no mode.
    id: 'cline',
    registryId: 'cline',
    memory: {
      runtime: runtime('npx', ['-y', 'cline@3.0.46']),
      expected: { managed: true, none: false, native: false }
    },
    scenario: {
      agentCapabilities: { loadSession: false },
      configOptions: [select('model', 'model', ['claude-sonnet', 'deepseek'])]
    },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: ['claude-sonnet', 'deepseek'],
      permissionModes: null,
      usage: false,
      skillsAgentId: 'cline'
    }
  },
  {
    // Devin: remote agent — streams a reply but advertises nothing (no loadSession,
    // no selectors, no MCP). Stands in for a hosted agent with a thin ACP surface.
    id: 'devin',
    registryId: 'devin',
    memory: {
      runtime: runtime('./bin/devin'),
      expected: { managed: true, none: false, native: false }
    },
    scenario: {
      agentCapabilities: {},
      prompt: {
        updates: [
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '$INPUT' } }
        ]
      }
    },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: null,
      permissionModes: null,
      usage: false,
      skillsAgentId: 'devin'
    }
  },
  {
    // Grok Build: model selector + http MCP, no loadSession, no mode.
    id: 'grok',
    registryId: 'grok-build',
    memory: {
      runtime: runtime('npx', ['-y', '@xai-official/grok@0.2.112', 'agent', 'stdio']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: {
      agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
      configOptions: [select('model', 'model', ['grok-code', 'grok-4'])],
      prompt: { usage: { used: 800, size: 128_000 } }
    },
    caps: {
      loadSession: false,
      mcp: { http: true, sse: false },
      promptImage: false,
      models: ['grok-code', 'grok-4'],
      permissionModes: null,
      usage: true,
      skillsAgentId: 'grok'
    }
  },
  {
    // NousResearch/hermes-agent@30c7913617a63773c15a11900d24ac362b7609c8.
    id: 'hermes',
    registryId: 'hermes-agent',
    memory: {
      runtime: runtime('hermes', ['acp']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: {
      agentCapabilities: {},
      configOptions: [select('model', 'model', ['claude-sonnet', 'openrouter/auto'])]
    },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: ['claude-sonnet', 'openrouter/auto'],
      permissionModes: null,
      usage: false,
      skillsAgentId: 'hermes-agent'
    }
  },
  {
    // OpenInterpreter/open-interpreter@a5fddab44f8aa3a26865c990ecf04a644d2948e7.
    id: 'interpreter',
    registryId: 'open-interpreter',
    memory: {
      runtime: runtime('interpreter', ['acp']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: {
      agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
      configOptions: [select('model', 'model', ['openai/gpt-5', 'anthropic/sonnet'])]
    },
    caps: {
      loadSession: false,
      mcp: { http: true, sse: false },
      promptImage: false,
      models: ['openai/gpt-5', 'anthropic/sonnet'],
      permissionModes: null,
      usage: false,
      skillsAgentId: null
    }
  },
  {
    // Kiro ACP/settings docs reviewed 2026-07-17; installed probe is the
    // compatibility authority because the documentation has no source revision.
    id: 'kiro',
    registryId: 'kiro-cli',
    memory: {
      runtime: runtime('kiro-cli', ['acp']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: {
      agentCapabilities: { loadSession: true },
      configOptions: [select('model', 'model', ['auto', 'claude-sonnet'])],
      load: { replay: [], title: 'Kiro session' }
    },
    caps: {
      loadSession: true,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: ['auto', 'claude-sonnet'],
      permissionModes: null,
      usage: false,
      skillsAgentId: 'kiro-cli'
    }
  },
  {
    // tontinton/maki@6034b1757484fb041afc68319cc782a40ccf87e4:
    // bundled memory cannot be disabled reliably, so managed is the sole mode.
    id: 'maki',
    registryId: 'maki',
    memory: {
      runtime: runtime('maki', ['acp']),
      expected: { managed: true, none: false, native: false }
    },
    scenario: { agentCapabilities: {}, prompt: {} },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: null,
      permissionModes: null,
      usage: false,
      skillsAgentId: null
    }
  },
  {
    // zeroclaw-labs/zeroclaw@0528f98936d1bda925d7ef930995bd285a252243.
    id: 'zeroclaw',
    registryId: 'zeroclaw',
    memory: {
      runtime: runtime('zeroclaw', ['acp']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: { agentCapabilities: {}, prompt: {} },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: null,
      permissionModes: null,
      usage: false,
      skillsAgentId: null
    }
  },
  {
    // can1357/oh-my-pi@b0d04e517335ada4e00ef8dc93aad9f4d1be8d21.
    id: 'omp',
    registryId: 'omp',
    memory: {
      runtime: runtime('omp', ['acp']),
      expected: { managed: true, none: true, native: false }
    },
    scenario: {
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
      configOptions: [
        select('model', 'model', ['anthropic/sonnet', 'openai/gpt-5']),
        select('mode', 'mode', ['default', 'plan'])
      ],
      prompt: { usage: { used: 640, size: 128_000 } },
      load: { replay: [], title: 'OMP session' }
    },
    caps: {
      loadSession: true,
      mcp: { http: true, sse: true },
      promptImage: false,
      models: ['anthropic/sonnet', 'openai/gpt-5'],
      permissionModes: ['default', 'plan'],
      usage: true,
      skillsAgentId: null
    }
  },
  {
    // Qoder CLI (@qoder-ai/qodercli) — native ACP via `qodercli --acp`. A
    // Gemini-CLI fork with bundled memory and no reviewed off-switch, so managed
    // is the sole verified mode (same classification as Maki).
    id: 'qoder-cli',
    registryId: 'qoder-cli',
    memory: {
      runtime: runtime('qodercli', ['--acp']),
      expected: { managed: true, none: false, native: false }
    },
    scenario: { agentCapabilities: {}, prompt: {} },
    caps: {
      loadSession: false,
      mcp: { http: false, sse: false },
      promptImage: false,
      models: null,
      permissionModes: null,
      usage: false,
      skillsAgentId: 'qoder'
    }
  }
]

export const profileById = (id: string): Profile => {
  const p = PROFILES.find((x) => x.id === id)
  if (!p) throw new Error(`unknown profile ${id}`)
  return p
}
