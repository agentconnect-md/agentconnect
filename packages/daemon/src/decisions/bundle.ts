import {
  DecisionBundle,
  decisionConditionIssues,
  supportsDecision,
  type ChannelDecisionGate,
  type DecisionBundleDefinition
} from '@agentconnect.md/protocol'

/** One enabled By decision gate with the definition it evaluates. */
export interface ResolvedDecisionGate {
  channel: string
  binding: ChannelDecisionGate
  definition: DecisionBundleDefinition
}

/** An integration's validated bundle: `bound` holds every channel with ANY binding, enabled or not. */
export interface ResolvedDecisionBundle {
  gates: ReadonlyMap<string, ResolvedDecisionGate>
  bound: ReadonlySet<string>
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
  const bound = new Set<string>()
  const parsed = DecisionBundle.safeParse(bundle)
  if (!parsed.success) {
    // An unreadable bundle still names its channels where it can, so they are held rather than opened.
    for (const binding of (bundle as { bindings?: unknown[] })?.bindings ?? []) {
      const channel = (binding as { channel?: unknown })?.channel
      if (typeof channel === 'string') bound.add(channel)
    }
    warn?.('decision: bundle failed validation; holding every bound conversation')
  } else {
    const definitions = new Map(parsed.data.definitions.map((d) => [d.id, d]))
    for (const binding of parsed.data.bindings) {
      bound.add(binding.channel)
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
  const result = { gates, bound }
  resolved.set(bundle, result)
  return result
}

function disabledReason(
  binding: DecisionBundle['bindings'][number],
  definitions: ReadonlyMap<string, DecisionBundleDefinition>
): string | undefined {
  if (!binding.enabled) return binding.disabledReason ?? 'disabled'
  if (binding.consumer.type !== 'gate') return `unsupported consumer ${binding.consumer.type}`
  const definition = definitions.get(binding.consumer.decisionId)
  if (!definition) return 'missing definition'
  if (decisionConditionIssues(definition.question, binding.consumer.when).length > 0) return 'incompatible condition'
  if (!supportsDecision(definition)) return 'unsupported model'
  return undefined
}
