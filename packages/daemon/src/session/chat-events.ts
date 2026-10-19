import type { ElicitCard } from '@agentconnect.md/protocol'

// Observations of the existing runtime; this stream owns neither execution nor durable history.
export type MaskedChatEvent = {
  sessionId: string
  turnId: string
  generation: number
  at: number
} & (
  | { kind: 'started'; text: string; origin: 'user' | 'agent' }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'boundary' }
  | {
      kind: 'tool'
      id: string
      title: string
      status: 'pending' | 'running' | 'completed' | 'failed'
      input?: string
      output?: string
    }
  | {
      kind: 'permission'
      requestId: string
      tool: string
      detail: string
      options?: { id: string; label: string; allow: boolean }[]
    }
  | {
      kind: 'permission_resolved'
      requestId: string
      outcome: 'allowed' | 'denied' | 'cancelled'
      selectedOptionId?: string
    }
  | ({ kind: 'elicitation' } & ElicitCard)
  | {
      kind: 'elicitation_resolved'
      requestId: string
      outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed'
      answers?: Record<string, string | number | boolean | string[]>
    }
  | { kind: 'finished'; outcome: 'complete' | 'cancelled' | 'failed'; error?: string }
  | { kind: 'discarded'; nextGeneration: number }
)
