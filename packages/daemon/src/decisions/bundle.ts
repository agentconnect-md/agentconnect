import {
  DecisionBundle,
  SharedBotRoutingProjection,
  decisionConditionIssues,
  decisionRoutingIssues,
  supportsDecision,
  type ChannelDecisionGate,
  type DecisionBundleDefinition,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'

/** One enabled By decision gate with the definition it evaluates. */
export interface ResolvedDecisionGate {
  channel: string
  binding: ChannelDecisionGate
  definition: DecisionBundleDefinition
}

/** One shared-bot routed channel; `routing` is present only where this daemon is the named evaluation host. */
export interface ResolvedRoutedChannel {
  channel: string
  enabled: boolean
  disabledReason?: string
  routing?: {
    botId: string
    config: SharedBotDecisionRouting
    definition: DecisionBundleDefinition
    defaultAgentId?: string
  }
}

/** An integration's validated bundle: `bound` holds every channel with ANY binding, enabled or not. */
export interface ResolvedDecisionBundle {
  gates: ReadonlyMap<string, ResolvedDecisionGate>
  routed: ReadonlyMap<string, ResolvedRoutedChannel>
  bound: ReadonlySet<string>
  sharedBotRouting?: { botId: string; config: SharedBotDecisionRouting }
}

// Bundles are replaced whole on every upsert and never edited in place, so identity keying is sound and logs once.
const resolved = new WeakMap<object, ResolvedDecisionBundle>()

/** Validate a delivered bundle; anything not provably executable stays bound but disabled (never Any). */
export function resolveDecisionBundle(
  bundle: DecisionBundle,
  warn?: (message: string) => void
): ResolvedDecisionBundle {
  const cached = resolved.get(bundle)
  if (cached) return cached
  const gates = new Map<string, ResolvedDecisionGate>()
  const routed = new Map<string, ResolvedRoutedChannel>()
  const bound = new Set<string>()
  let sharedBotRouting: ResolvedDecisionBundle['sharedBotRouting']
  // The host projection validates on its own, so a malformed one holds routed channels without taking the gates down.
  const { sharedBotRouting: projection, ...rest } = (bundle ?? {}) as DecisionBundle & { sharedBotRouting?: unknown }
  const parsed = DecisionBundle.safeParse(rest)
  if (!parsed.success) {
    // An unreadable bundle still names its channels where it can, so they are held rather than opened.
    for (const binding of (bundle as { bindings?: unknown[] })?.bindings ?? []) {
      const channel = (binding as { channel?: unknown })?.channel
      if (typeof channel === 'string') bound.add(channel)
    }
    warn?.('decision: bundle failed validation; holding every bound conversation')
  } else {
    const definitions = new Map(parsed.data.definitions.map((d) => [d.id, d]))
    const host = hostRouting(projection, definitions, warn)
    if (host) sharedBotRouting = { botId: host.botId, config: host.config }
    for (const binding of parsed.data.bindings) {
      bound.add(binding.channel)
      // A router binding is never a gate: it stays bound and held here until 5b routes it.
      if (binding.consumer.type === 'shared_bot_routing') {
        const hosted = binding.enabled ? host?.channels.get(binding.channel) : undefined
        routed.set(binding.channel, {
          channel: binding.channel,
          enabled: binding.enabled,
          ...(binding.disabledReason ? { disabledReason: binding.disabledReason } : {}),
          ...(host && hosted
            ? {
                routing: {
                  botId: host.botId,
                  config: host.config,
                  definition: host.definition,
                  ...(hosted.defaultAgentId ? { defaultAgentId: hosted.defaultAgentId } : {})
                }
              }
            : {})
        })
        if (!binding.enabled)
          warn?.(`decision: routed ${binding.channel} disabled (${binding.disabledReason ?? 'disabled'})`)
        continue
      }
      const reason = disabledReason(binding, definitions)
      if (reason) {
        warn?.(`decision: binding for ${binding.channel} disabled (${reason})`)
        continue
      }
      const gate = binding.consumer as ChannelDecisionGate
      gates.set(binding.channel, {
        channel: binding.channel,
        binding: gate,
        definition: definitions.get(gate.decisionId)!
      })
    }
  }
  const result: ResolvedDecisionBundle = { gates, routed, bound, ...(sharedBotRouting ? { sharedBotRouting } : {}) }
  resolved.set(bundle, result)
  return result
}

/** The host projection, only when its config parses, its Decision is present and valid, and its model is supported. */
function hostRouting(
  projection: unknown,
  definitions: ReadonlyMap<string, DecisionBundleDefinition>,
  warn?: (message: string) => void
):
  | {
      botId: string
      config: SharedBotDecisionRouting
      definition: DecisionBundleDefinition
      channels: ReadonlyMap<string, { defaultAgentId?: string }>
    }
  | undefined {
  if (projection === undefined) return undefined
  const parsed = SharedBotRoutingProjection.safeParse(projection)
  const definition = parsed.success ? definitions.get(parsed.data.config.decisionId) : undefined
  if (
    !parsed.success ||
    !definition ||
    decisionRoutingIssues(definition.question, parsed.data.config).length > 0 ||
    !supportsDecision(definition)
  ) {
    warn?.('decision: shared-bot routing failed validation; holding every routed conversation')
    return undefined
  }
  return {
    botId: parsed.data.botId,
    config: parsed.data.config,
    definition,
    channels: new Map(
      parsed.data.channels.map((c) => [c.channel, c.defaultAgentId ? { defaultAgentId: c.defaultAgentId } : {}])
    )
  }
}

function disabledReason(
  binding: DecisionBundle['bindings'][number],
  definitions: ReadonlyMap<string, DecisionBundleDefinition>
): string | undefined {
  if (!binding.enabled) return binding.disabledReason ?? 'disabled'
  if (binding.consumer.type !== 'gate') return 'not a gate'
  const definition = definitions.get(binding.consumer.decisionId)
  if (!definition) return 'missing definition'
  if (decisionConditionIssues(definition.question, binding.consumer.when).length > 0) return 'incompatible condition'
  if (!supportsDecision(definition)) return 'unsupported model'
  return undefined
}

/** Sorted-key JSON, so two equal configurations always serialize alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** What a pending verdict is bound to (decisions.md §8.3); a rename alone leaves it unchanged. */
export function gateFingerprint(gate: ResolvedDecisionGate): string {
  return canonicalJson({
    decisionId: gate.definition.id,
    providerId: gate.definition.providerId,
    model: gate.definition.model,
    question: gate.definition.question,
    when: gate.binding.when
  })
}

/** The frozen, credential-free configuration a verdict carries. */
export interface FrozenGateConfig {
  decisionId: string
  providerId: string
  model: string
  question: ResolvedDecisionGate['definition']['question']
  condition: ChannelDecisionGate['when']
  binding: { channel: string; consumer: ChannelDecisionGate }
  sessionMode: string
  fingerprint: string
}

export function frozenGateConfig(gate: ResolvedDecisionGate, sessionMode: string): FrozenGateConfig {
  return {
    decisionId: gate.definition.id,
    providerId: gate.definition.providerId,
    model: gate.definition.model,
    question: gate.definition.question,
    condition: gate.binding.when,
    binding: { channel: gate.channel, consumer: gate.binding },
    sessionMode,
    fingerprint: gateFingerprint(gate)
  }
}

/** What a pending router verdict is bound to; a Decision rename alone leaves it unchanged. */
export function routerFingerprint(routing: NonNullable<ResolvedRoutedChannel['routing']>, channel: string): string {
  return canonicalJson({
    channel,
    botId: routing.botId,
    enabled: routing.config.enabled,
    decisionId: routing.definition.id,
    providerId: routing.definition.providerId,
    model: routing.definition.model,
    question: routing.definition.question,
    rules: routing.config.rules,
    otherwise: routing.config.otherwise,
    defaultAgentId: routing.defaultAgentId ?? null
  })
}
