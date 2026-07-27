import type { SessionMessageDto } from '@/lib/api'
import { parseTranscriptTime } from '@/lib/transcript-time'

/** Upsert stable transcript rows and restore the platform's display ordering. */
export function mergeSessionMessages(
  current: SessionMessageDto[],
  incoming: SessionMessageDto[],
  platform: string
): SessionMessageDto[] {
  if (incoming.length === 0) return current
  const bySeq = new Map(current.map((message) => [message.seq, message]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => {
    if (platform !== 'slack') return a.seq - b.seq
    return (parseTranscriptTime(a.ts) ?? 0) - (parseTranscriptTime(b.ts) ?? 0) || a.seq - b.seq
  })
}
