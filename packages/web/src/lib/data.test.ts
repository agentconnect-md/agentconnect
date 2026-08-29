import { describe, expect, it } from 'vitest'
import {
  agentEffortDisplay,
  agentModelDisplay,
  agentPermissionDisplay,
  displayedEffort,
  enrichSessionWithAgent,
  effectiveAgentStatus,
  effortChoicesFor,
  effortField,
  fastModeAvailableFor,
  lifecycleStatus,
  conversationRowKey,
  mergeCanonicalSessions,
  rosterParticipantName,
  modelCapability,
  modelLabel,
  permissionModeChoicesFor,
  preferredModelFor,
  PLAYGROUND_CHANNEL_FILTER,
  resolvedPermissionMode,
  permissionModeOptions,
  presentedDaemonStatus,
  resolveEffortForModel,
  sessionChannelDisplay,
  sessionChannelFilterValue,
  status,
  type DaemonRow,
  type RuntimeModelCatalog,
  type Session
} from './data'

describe('planned daemon lifecycle status', () => {
  it('keeps online agents in the explicit restart or upgrade transition', () => {
    expect(lifecycleStatus({ op: 'upgrade', status: 'pending' })).toBe('upgrading')
    expect(lifecycleStatus({ op: 'restart', status: 'pending' })).toBe('restarting')
    expect(lifecycleStatus({ op: 'upgrade', status: 'succeeded' })).toBeUndefined()
    const upgrading = { status: 'offline' as const, lifecycleStatus: 'upgrading' as const }
    expect(presentedDaemonStatus(upgrading)).toBe('upgrading')
    const placed = (status: 'online' | 'paused') => ({ status, daemon: 'daemon-1' })
    expect(effectiveAgentStatus(placed('online'), upgrading)).toBe('upgrading')
    expect(effectiveAgentStatus(placed('online'), { status: 'offline', lifecycleStatus: null })).toBe('offline')
    expect(effectiveAgentStatus(placed('paused'), upgrading)).toBe('paused')
  })

  it('reads an unplaced agent as offline whatever its stored status says', () => {
    // A deleted daemon clears the placement; a stale 'active'/'online' status must not
    // survive that as a green dot on an agent with nothing hosting it.
    expect(effectiveAgentStatus({ status: 'online', daemon: '—' }, undefined)).toBe('offline')
    expect(effectiveAgentStatus({ status: 'online', daemon: 'daemon-1' }, undefined)).toBe('online')
  })

  it('uses the transition tone while a pending daemon is still connected', () => {
    const restarting = { status: 'online' as const, lifecycleStatus: 'restarting' as const }
    expect(status(presentedDaemonStatus(restarting))).toMatchObject({
      label: 'restarting',
      text: '#9a6500'
    })
  })
})

describe('sessionChannelFilterValue', () => {
  it('groups live and persisted Playground conversations under one filter value', () => {
    expect(
      [
        { platform: 'playground', channel: 'Playground' },
        { platform: 'webchat', channel: 'Playground', channelId: 'conversation-1' },
        { platform: 'webchat', channel: 'Playground', channelId: 'conversation-2' }
      ].map(sessionChannelFilterValue)
    ).toEqual([PLAYGROUND_CHANNEL_FILTER, PLAYGROUND_CHANNEL_FILTER, PLAYGROUND_CHANNEL_FILTER])
  })

  it('keeps a normal integration channel addressable by its raw id', () => {
    expect(sessionChannelFilterValue({ platform: 'slack', channel: '#general', channelId: 'C123' })).toBe('C123')
  })
})

describe('sessionChannelDisplay', () => {
  const cronName = (id: string) => (id === 'e23c6ea3-57bd-4bce-b014-81077c865059' ? 'Nightly report' : undefined)

  it('resolves a headless cron channel to its schedule name under the schedule mark', () => {
    expect(
      sessionChannelDisplay({ platform: 'slack', channel: 'cron:e23c6ea3-57bd-4bce-b014-81077c865059' }, cronName)
    ).toEqual({ platform: 'schedule', label: 'Nightly report' })
  })

  it('falls back to a short schedule id while the crons list is still loading', () => {
    expect(sessionChannelDisplay({ platform: 'slack', channel: 'cron:0f9b3a10-dead-beef' }, cronName)).toEqual({
      platform: 'schedule',
      label: 'Schedule 0f9b3a10'
    })
  })

  it('leaves real platform channels untouched', () => {
    expect(sessionChannelDisplay({ platform: 'slack', channel: '#deploys' }, cronName)).toEqual({
      platform: 'slack',
      label: '#deploys'
    })
  })
})

describe('mergeCanonicalSessions', () => {
  const persisted: Session = {
    id: 'session-real',
    title: 'Persisted title',
    time: 'now',
    status: 'online',
    platform: 'webchat',
    channel: 'Playground',
    channelId: 'conversation-1',
    user: '@you',
    duration: 'live',
    tokens: '0',
    cost: '—',
    toolCount: '0',
    statusLabel: 'Live',
    steps: []
  }

  it('collapses a live Playground row into its durable session identity', () => {
    const live = {
      ...persisted,
      id: 'pg_agent-temporary',
      realSessionId: persisted.id,
      title: 'Live title',
      platform: 'playground'
    }

    expect(mergeCanonicalSessions([persisted, live])).toEqual([
      expect.objectContaining({ id: 'session-real', realSessionId: 'session-real', title: 'Live title' })
    ])
  })

  describe('conversationRowKey', () => {
    it('gives two rows of one conversation the same identity, whatever represents them', () => {
      // A filtered list names the newest member the filter still covers; the open
      // page names the newest member outright. Narrow a two-agent filter to one
      // participant and those part company — on the session id the conversation
      // would list itself twice.
      const listed = { ...persisted, id: 'member-a', conversationKey: 'conv-1' }
      const open = { ...persisted, id: 'member-b', conversationKey: 'conv-1' }
      expect(conversationRowKey(listed)).toBe(conversationRowKey(open))
    })

    it('falls back to the session for a row that belongs to no conversation', () => {
      expect(conversationRowKey(persisted)).toBe('session-real')
      expect(conversationRowKey({ ...persisted, id: 'pg_x', realSessionId: 'session-real' })).toBe('session-real')
    })
  })
})

describe('rosterParticipantName', () => {
  const participant = { agentId: 'b7e0f2c1-4a5d-4e6f-8a9b-0c1d2e3f4a5b', name: 'reviewer' }

  it('prefers the org agent list over whatever name the roster carried', () => {
    // The list row's roster is built before the rows are enriched, so its `name`
    // can lag a rename the agent list already has.
    expect(rosterParticipantName(participant, { name: 'reviewer', displayName: 'Reviewer' })).toBe('Reviewer')
  })

  it('keeps a real roster name when the agent is not in the viewer’s list', () => {
    expect(rosterParticipantName(participant)).toBe('reviewer')
  })

  it('refuses to render an id as a name', () => {
    // Conversation mode synthesizes the roster from member ids alone, and an
    // adopted session's detail roster falls back to the short id.
    expect(rosterParticipantName({ agentId: participant.agentId, name: participant.agentId })).toBe('Agent')
    expect(rosterParticipantName({ agentId: participant.agentId, name: participant.agentId.slice(0, 8) })).toBe('Agent')
    expect(rosterParticipantName({ agentId: participant.agentId, name: '  ' })).toBe('Agent')
    expect(rosterParticipantName({ agentId: participant.agentId })).toBe('Agent')
  })
})

describe('enrichSessionWithAgent', () => {
  const session: Session = {
    id: 'session-1',
    title: 'Session',
    time: 'now',
    status: 'offline',
    platform: 'slack',
    channel: '#general',
    user: 'Dana',
    duration: '—',
    tokens: '—',
    cost: '—',
    toolCount: '—',
    statusLabel: 'idle',
    steps: [],
    agentId: 'agent-1'
  }
  const agent = {
    name: 'reviewer',
    displayName: 'Reviewer',
    model: 'current-model',
    runtime: 'codex',
    daemon: 'daemon-current'
  }

  it('attaches the agent label and uses current execution config only for legacy rows', () => {
    expect(enrichSessionWithAgent(session, agent)).toMatchObject({
      agentName: 'Reviewer',
      model: 'current-model',
      runtime: 'codex',
      daemon: 'daemon-current'
    })
    expect(enrichSessionWithAgent({ ...session, runtime: 'claude', daemon: 'daemon-recorded' }, agent)).toMatchObject({
      agentName: 'Reviewer',
      model: '',
      runtime: 'claude',
      daemon: 'daemon-recorded'
    })
  })

  it('keeps the Session-projected name when the Agent itself is hidden', () => {
    expect(enrichSessionWithAgent({ ...session, agentName: 'Payments Agent' })).toMatchObject({
      agentName: 'Payments Agent'
    })
  })
})

const catalog = (over: Partial<RuntimeModelCatalog> = {}): RuntimeModelCatalog => ({
  models: [
    { id: 'opus', efforts: [{ value: 'high' }], fastMode: false },
    { id: 'sonnet', efforts: [], fastMode: true }
  ],
  defaultModel: 'opus',
  source: 'acp',
  observedAt: '2026-07-18T00:00:00.000Z',
  ...over
})

const daemonWith = (modelCatalog: RuntimeModelCatalog | null): Pick<DaemonRow, 'runtimeModels'> => ({
  runtimeModels: [{ runtime: 'claude', version: '1.0.0', models: ['opus', 'sonnet'], modelCatalog }]
})

describe('modelCapability', () => {
  it('returns the catalog entry for the selected model id', () => {
    expect(modelCapability(daemonWith(catalog()), 'claude', 'sonnet')?.id).toBe('sonnet')
  })

  it("resolves the UI 'Default' choice ('') through the catalog defaultModel", () => {
    expect(modelCapability(daemonWith(catalog()), 'claude', '')?.id).toBe('opus')
  })

  it("is undefined for '' when the catalog has no defaultModel", () => {
    expect(modelCapability(daemonWith(catalog({ defaultModel: undefined })), 'claude', '')).toBeUndefined()
  })

  it('is undefined without a catalog, for an unknown model, or for another runtime', () => {
    expect(modelCapability(daemonWith(null), 'claude', 'opus')).toBeUndefined()
    expect(modelCapability(undefined, 'claude', 'opus')).toBeUndefined()
    expect(modelCapability(daemonWith(catalog()), 'claude', 'haiku')).toBeUndefined()
    expect(modelCapability(daemonWith(catalog()), 'codex', 'opus')).toBeUndefined()
  })
})

describe('effortChoicesFor', () => {
  it('falls back to the static effortField options exactly when the capability is absent', () => {
    for (const runtime of ['claude', 'codex']) {
      expect(effortChoicesFor(runtime, undefined)).toEqual(
        effortField(runtime).options.map((o) => ({ value: o.v, label: o.l }))
      )
    }
  })

  it('falls back to the static options when the capability carries no efforts (not yet sniffed)', () => {
    expect(effortChoicesFor('claude', { id: 'opus' })).toEqual(
      effortField('claude').options.map((o) => ({ value: o.v, label: o.l }))
    )
  })

  it('returns [] for a model with no effort selector (efforts: [])', () => {
    expect(effortChoicesFor('claude', { id: 'sonnet', efforts: [] })).toEqual([])
  })

  it('labels catalog efforts by name → static table → capitalized value, keeping descriptions', () => {
    expect(
      effortChoicesFor('codex', {
        id: 'gpt-5',
        efforts: [{ value: 'low', name: 'Snappy', description: 'fastest' }, { value: 'xhigh' }, { value: 'minimal' }]
      })
    ).toEqual([
      { value: 'low', label: 'Snappy', description: 'fastest' },
      { value: 'xhigh', label: 'Extra High' },
      { value: 'minimal', label: 'Minimal' }
    ])
  })
})

describe('fastModeAvailableFor', () => {
  it('uses the capability verdict when defined', () => {
    expect(fastModeAvailableFor('claude', { id: 'opus', fastMode: false })).toBe(false)
    expect(fastModeAvailableFor('opencode', { id: 'm', fastMode: true })).toBe(true)
  })

  it('falls back to the static supportsModes behavior otherwise', () => {
    expect(fastModeAvailableFor('claude', undefined)).toBe(true)
    expect(fastModeAvailableFor('claude', { id: 'opus' })).toBe(true)
    expect(fastModeAvailableFor('opencode', undefined)).toBe(false)
  })
})

describe('permissionModeChoicesFor', () => {
  it('falls back to the static table when the catalog carries no modes', () => {
    expect(permissionModeChoicesFor('codex', undefined)).toEqual(permissionModeOptions('codex'))
    expect(permissionModeChoicesFor('claude', catalog({ permissionModes: [] }))).toEqual(
      permissionModeOptions('claude')
    )
  })

  it('labels catalog modes by name → static table → capitalized value', () => {
    expect(
      permissionModeChoicesFor(
        'claude',
        catalog({
          permissionModes: [
            { value: 'plan', name: 'Plan first', description: 'Inspect the workspace without making changes.' },
            { value: 'acceptEdits' },
            { value: 'yolo' }
          ]
        })
      )
    ).toEqual([
      { v: 'plan', l: 'Plan first', description: 'Inspect the workspace without making changes.' },
      { v: 'acceptEdits', l: 'Accept Edits' },
      { v: 'yolo', l: 'Yolo' }
    ])
  })
})

describe('Codex permission modes', () => {
  it("offers exactly the modes the runtime owns, under Codex's own names", () => {
    expect(permissionModeOptions('codex')).toEqual([
      { v: 'read-only', l: 'Read Only' },
      { v: 'agent', l: 'Approve for me' },
      { v: 'agent-full-access', l: 'Full Access' }
    ])
  })
})

describe('resolveEffortForModel', () => {
  const cap = (efforts: string[], defaultEffort?: string) => ({
    id: 'm',
    efforts: efforts.map((value) => ({ value })),
    ...(defaultEffort ? { defaultEffort } : {})
  })

  it('keeps a selection the model offers', () => {
    expect(resolveEffortForModel('codex', cap(['low', 'high']), 'high')).toBe('high')
  })

  it('drops an unavailable selection to the model default level', () => {
    expect(resolveEffortForModel('codex', cap(['low', 'medium', 'high'], 'medium'), 'ultracode')).toBe('medium')
  })

  it('degrades along the ladder when no default is known (down first, then up)', () => {
    expect(resolveEffortForModel('codex', cap(['low', 'medium', 'xhigh']), 'max')).toBe('xhigh')
    expect(resolveEffortForModel('codex', cap(['high', 'xhigh']), 'low')).toBe('high')
  })

  it('falls back to runtime default for empty vocabularies and keeps "" as-is', () => {
    expect(resolveEffortForModel('codex', cap([]), 'xhigh')).toBe('')
    expect(resolveEffortForModel('codex', cap(['low']), '')).toBe('')
  })

  it('uses the static table when the model has no capability entry', () => {
    // 'xhigh' exists in the static codex table — selection survives an unknown model
    expect(resolveEffortForModel('codex', undefined, 'xhigh')).toBe('xhigh')
  })
})

describe('preferredModelFor', () => {
  const daemonWith = (models: string[], defaultModel?: string): Pick<DaemonRow, 'runtimeModels'> => ({
    runtimeModels: [
      {
        runtime: 'codex',
        version: '1',
        models,
        acpProtocolVersion: null,
        mcpCapabilities: null,
        modelCatalog: defaultModel
          ? { models: [], defaultModel, source: 'native', observedAt: '2026-07-18T00:00:00Z' }
          : null
      }
    ]
  })

  it('preselects the catalog default when it is advertised', () => {
    expect(preferredModelFor(daemonWith(['a', 'b'], 'b'), 'codex')).toBe('b')
  })

  it('falls back to the first advertised model when no default is resolvable', () => {
    expect(preferredModelFor(daemonWith(['a', 'b']), 'codex')).toBe('a')
    expect(preferredModelFor(daemonWith(['a', 'b'], 'gone'), 'codex')).toBe('a')
  })

  it("returns '' when nothing is advertised (runtime default is the only choice)", () => {
    expect(preferredModelFor(daemonWith([]), 'codex')).toBe('')
    expect(preferredModelFor(undefined, 'codex')).toBe('')
  })
})

describe('displayedEffort', () => {
  const choices = (values: string[]) => values.map((value) => ({ value, label: value }))

  it('lights the stored selection when present', () => {
    expect(displayedEffort('high', choices(['default', 'low', 'high']))).toBe('high')
  })

  it("lights the vocabulary's Default entry when nothing is stored", () => {
    expect(displayedEffort('', choices(['default', 'low', 'high']))).toBe('default')
  })

  it('keeps the unselected state for vocabularies without a default sentinel', () => {
    expect(displayedEffort('', choices(['low', 'high']))).toBe('')
  })
})

describe('displayedEffort defaultEffort fallback + resolvedPermissionMode', () => {
  const choices = (values: string[]) => values.map((value) => ({ value, label: value }))
  const catalog = (modes: string[], defaultMode?: string): RuntimeModelCatalog => ({
    models: [],
    permissionModes: modes.map((value) => ({ value })),
    ...(defaultMode ? { defaultPermissionMode: defaultMode } : {}),
    source: 'acp',
    observedAt: '2026-07-18T00:00:00Z'
  })

  it('without a default sentinel, lights the observed default level', () => {
    expect(displayedEffort('', choices(['none', 'low', 'medium']), 'medium')).toBe('medium')
    expect(displayedEffort('', choices(['none', 'low']), 'gone')).toBe('')
  })

  it('the sentinel wins over the observed default', () => {
    expect(displayedEffort('', choices(['default', 'low']), 'low')).toBe('default')
  })

  it('resolves a phantom permission mode to the runtime default, else the first offered', () => {
    expect(
      resolvedPermissionMode(
        'default',
        [
          { v: 'agent', l: 'Agent' },
          { v: 'plan', l: 'Plan' }
        ],
        catalog(['agent', 'plan'], 'agent')
      )
    ).toBe('agent')
    expect(
      resolvedPermissionMode(
        'default',
        [
          { v: 'agent', l: 'Agent' },
          { v: 'plan', l: 'Plan' }
        ],
        catalog(['agent', 'plan'])
      )
    ).toBe('agent')
  })

  it('keeps an offered mode and the static path untouched', () => {
    expect(
      resolvedPermissionMode(
        'plan',
        [
          { v: 'agent', l: 'A' },
          { v: 'plan', l: 'P' }
        ],
        catalog(['agent', 'plan'], 'agent')
      )
    ).toBe('plan')
    expect(resolvedPermissionMode('default', [{ v: 'default', l: 'D' }], undefined)).toBe('default')
  })
})

describe('shared label chrome stripping (pi "Thinking: …" pills)', () => {
  const cap = (names: string[]) => ({
    id: 'm',
    efforts: names.map((name, i) => ({ value: `v${i}`, name }))
  })

  it('strips a colon-separated prefix repeated on every label and re-capitalizes', () => {
    expect(
      effortChoicesFor('pi', cap(['Thinking: off', 'Thinking: minimal', 'Thinking: xhigh'])).map((o) => o.label)
    ).toEqual(['Off', 'Minimal', 'Xhigh'])
  })

  it('leaves labels alone when the prefix is not shared by all, has no colon, or would empty one', () => {
    expect(effortChoicesFor('pi', cap(['Thinking: off', 'Effort: low'])).map((o) => o.label)).toEqual([
      'Thinking: off',
      'Effort: low'
    ])
    expect(effortChoicesFor('pi', cap(['Very High', 'Very Low'])).map((o) => o.label)).toEqual([
      'Very High',
      'Very Low'
    ])
    expect(effortChoicesFor('pi', cap(['Thinking: ', 'Thinking: low'])).map((o) => o.label)).toEqual([
      'Thinking: ',
      'Thinking: low'
    ])
  })

  it('applies to permission-mode labels too', () => {
    const catalog: RuntimeModelCatalog = {
      models: [],
      permissionModes: [
        { value: 'safe', name: 'Mode: safe' },
        { value: 'yolo', name: 'Mode: yolo' }
      ],
      source: 'acp',
      observedAt: '2026-07-18T00:00:00Z'
    }
    expect(permissionModeChoicesFor('pi', catalog)).toEqual([
      { v: 'safe', l: 'Safe' },
      { v: 'yolo', l: 'Yolo' }
    ])
  })

  it('never strips single-choice vocabularies', () => {
    expect(effortChoicesFor('pi', cap(['Thinking: only'])).map((o) => o.label)).toEqual(['Thinking: only'])
  })
})

describe('literal ACP default model surfacing', () => {
  const daemonWith = (models: string[], defaultModel?: string): Pick<DaemonRow, 'runtimeModels'> => ({
    runtimeModels: [
      {
        runtime: 'claude',
        version: '1',
        models,
        modelCatalog: defaultModel
          ? { models: [], defaultModel, source: 'acp', observedAt: '2026-07-18T00:00:00Z' }
          : null
      }
    ]
  })

  it('shows every advertised id verbatim, an absent model as the em-dash', () => {
    // The runtime's own casing wins — a literal `default` is a real ACP model id,
    // not a stand-in for "unset", so it must not be re-cased to "Default".
    expect(modelLabel('default')).toBe('default')
    expect(modelLabel('opus[1m]')).toBe('opus[1m]')
    expect(modelLabel('')).toBe('—')
    expect(modelLabel('—')).toBe('—')
  })

  it("preselects the advertised 'default' when it leads the list and no concrete default is resolved", () => {
    expect(preferredModelFor(daemonWith(['default', 'opus[1m]', 'sonnet']), 'claude')).toBe('default')
  })

  it('still prefers a concrete resolved default over a leading literal default', () => {
    expect(preferredModelFor(daemonWith(['default', 'opus[1m]'], 'opus[1m]'), 'claude')).toBe('opus[1m]')
  })
})

// Read-only config surfaces (detail card, list rows) must show the SAME effective
// values the Add/Edit pickers do — a blank model resolves to the daemon default,
// and effort/permission use the runtime catalog's own names. Reproduces the Codex
// mismatch that motivated these helpers (card "Default / Extra High / Full Access"
// vs editor "gpt-5.6-sol / Xhigh / Agent (full access)").
describe('agent config display helpers (card ↔ editor parity)', () => {
  // A Codex daemon whose catalog names differ from the static tables.
  const codexDaemon: Pick<DaemonRow, 'runtimeModels'> = {
    runtimeModels: [
      {
        runtime: 'codex',
        version: '1.1.4',
        models: ['gpt-5.6-sol', 'gpt-5.6-mini'],
        modelCatalog: {
          models: [
            {
              id: 'gpt-5.6-sol',
              defaultEffort: 'medium',
              efforts: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                { value: 'xhigh', name: 'Xhigh' },
                { value: 'max', name: 'Max' },
                { value: 'ultra', name: 'Ultra' }
              ]
            }
          ],
          defaultModel: 'gpt-5.6-sol',
          permissionModes: [
            { value: 'read-only', name: 'Read only' },
            { value: 'agent', name: 'Ask for approval' },
            { value: 'agent-full-access', name: 'Agent (full access)' }
          ],
          defaultPermissionMode: 'agent',
          source: 'acp',
          observedAt: '2026-07-19T00:00:00.000Z'
        }
      }
    ]
  }

  describe('agentModelDisplay', () => {
    it('resolves a blank model to the daemon-advertised default', () => {
      expect(agentModelDisplay(codexDaemon, 'codex', '')).toBe('gpt-5.6-sol')
    })
    it('shows an explicit stored model verbatim', () => {
      expect(agentModelDisplay(codexDaemon, 'codex', 'gpt-5.6-mini')).toBe('gpt-5.6-mini')
    })
    it('folds a non-advertised "default" to the daemon default, em-dash without a catalog', () => {
      // codexDaemon does NOT advertise a literal `default` → treated as the blank
      // sentinel and resolved, exactly as the editor does.
      expect(agentModelDisplay(codexDaemon, 'codex', 'default')).toBe('gpt-5.6-sol')
      // Nothing advertised ⇒ no model to name; the editor offers no choice either.
      expect(agentModelDisplay(undefined, 'codex', '')).toBe('—')
    })
    it('keeps a runtime-advertised literal "default" verbatim (matches Edit)', () => {
      // Some ACP runtimes surface `default` as a real picker option. An agent
      // stored with model:'default' keeps that selection in Edit (rendered
      // `default`, the runtime's own id) even though the catalog resolves a
      // concrete default — the read-only surface must not swap it, nor re-case it.
      const daemon: Pick<DaemonRow, 'runtimeModels'> = {
        runtimeModels: [
          {
            runtime: 'claude',
            version: '1',
            models: ['default', 'opus[1m]'],
            modelCatalog: {
              models: [{ id: 'opus[1m]', efforts: [{ value: 'high', name: 'High' }] }],
              defaultModel: 'opus[1m]',
              source: 'acp',
              observedAt: '2026-07-19T00:00:00.000Z'
            }
          }
        ]
      }
      expect(agentModelDisplay(daemon, 'claude', 'default')).toBe('default')
      // …while a blank model still resolves to the concrete advertised default.
      expect(agentModelDisplay(daemon, 'claude', '')).toBe('opus[1m]')
    })
  })

  describe('agentEffortDisplay', () => {
    it('uses the catalog name for the stored effort (matches the lit pill)', () => {
      expect(agentEffortDisplay(codexDaemon, 'codex', '', 'xhigh')).toBe('Xhigh')
    })
    it("lights the model's own default level when effort is unset", () => {
      expect(agentEffortDisplay(codexDaemon, 'codex', '', '')).toBe('Medium')
    })
    it('falls back to the static effort table without a catalog', () => {
      expect(agentEffortDisplay(undefined, 'codex', '', 'xhigh')).toBe('Extra High')
    })
  })

  describe('agentPermissionDisplay', () => {
    it('uses the catalog name for the stored permission mode', () => {
      expect(agentPermissionDisplay(codexDaemon, 'codex', 'agent-full-access')).toBe('Agent (full access)')
    })
    it('resolves a blank mode through the catalog default', () => {
      expect(agentPermissionDisplay(codexDaemon, 'codex', '')).toBe('Ask for approval')
    })
    it('falls back to the static permission table without a catalog', () => {
      expect(agentPermissionDisplay(undefined, 'codex', 'agent-full-access')).toBe('Full Access')
    })
  })
})
