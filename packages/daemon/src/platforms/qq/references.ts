import type { QQQuotedMessage } from '@agentconnect.md/message'

// Each connection owns a bounded index; identical QQ indices in different conversations never alias.
export class QQReferences {
  private readonly entries = new Map<string, QQQuotedMessage>()

  get(channel: string, key: string): QQQuotedMessage | undefined {
    return this.entries.get(JSON.stringify([channel, key]))
  }

  remember(channel: string, keys: (string | undefined)[], entry: QQQuotedMessage): void {
    const content = entry.content?.slice(0, 1000)
    const bounded = {
      ...entry,
      content,
      attachments: entry.attachments?.slice(0, 10),
      ...(entry.content && entry.content.length > 1000 ? { excerpt: true } : {})
    }
    for (const key of keys) {
      if (!key) continue
      const scoped = JSON.stringify([channel, key])
      this.entries.delete(scoped)
      this.entries.set(scoped, bounded)
    }
    while (this.entries.size > 2000) this.entries.delete(this.entries.keys().next().value!)
  }
}
