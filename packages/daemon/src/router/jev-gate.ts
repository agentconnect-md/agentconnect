/**
 * Semantic wake gate for IMPLICIT deliveries (thread fan-out, auto rules).
 * A small judgment model (TypeSafe Jev) scores whether each candidate agent
 * should wake for this message; below-threshold candidates stay transcript-only.
 * Explicit @mentions never pass through here — the caller only asks about
 * `implicit` peers. Fail-closed: any transport/parse trouble means "don't wake".
 */
export interface JevGateConfig {
  enabled: boolean
  endpoint: string
  apiKeyEnv: string
  model: string
  threshold: number
  contextMessages: number
  timeoutMs: number
}

export interface JevGateCandidate {
  agentId: string
  name: string
  role?: string | undefined
}

export interface JevGateMessage {
  author: string
  kind: 'human' | 'agent'
  text: string
  ago_s: number
}

export interface JevGateRequest {
  channelLabel: string
  isThread: boolean
  recent: JevGateMessage[]
  newMessage: { author: string; text: string; mentions: string[] }
  candidates: JevGateCandidate[]
}

/** Per-candidate yes-probability keyed by agentId. `null` = judgment unavailable. */
export type JevGateVerdict = Map<string, number> | null

const TEXT_CAP = 300

const clip = (s: string) => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s)

export async function judgeImplicitWake(
  cfg: JevGateConfig,
  req: JevGateRequest,
  log?: { debug(msg: string): void; warn?(msg: string): void }
): Promise<JevGateVerdict> {
  const apiKey = process.env[cfg.apiKeyEnv]
  if (!apiKey || req.candidates.length === 0) return null

  const state = {
    context: `群聊对话（${req.channelLabel}${req.isThread ? ' / 子区' : ''}）。成员分两类：人类和几个 AI agent。agent 像群成员一样在场能看到所有消息，但不应该每条都插话。`,
    recent_messages: req.recent.map((m) => ({ author: m.author, kind: m.kind, text: clip(m.text), ago_s: m.ago_s })),
    new_message: { author: req.newMessage.author, text: clip(req.newMessage.text), mentions: req.newMessage.mentions },
    agents: req.candidates.map((c) => ({ name: c.name, role: c.role ?? '' }))
  }
  const questions = Object.fromEntries(
    req.candidates.map((c) => [
      `wake_${c.agentId}`,
      {
        type: 'noul',
        instructions:
          `Agent「${c.name}」应该被唤醒来回应这条新消息吗？它的角色定位：${c.role ?? '群里的 AI 助手'}。` +
          'new_message.mentions 是消息里正式 @ 的 agent 列表（空 = 没有正式点名）。',
        criteria: {
          true: `这条消息需要「${c.name}」回应：它被正式 @、问题属于它的角色、它正参与的对话在延续、或消息向群里提问而它合适`,
          false: `消息与它无关、被正式 @ 的是别人而它没被需要、纯人类间对话、礼貌性收尾、或不需要任何 agent`
        }
      }
    ])
  )

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    })
    if (!res.ok) {
      log?.warn?.(`jev gate: HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { answers?: Record<string, { noul?: number }> }
    const verdict = new Map<string, number>()
    for (const c of req.candidates) {
      const p = body.answers?.[`wake_${c.agentId}`]?.noul
      if (typeof p === 'number') verdict.set(c.agentId, p)
    }
    return verdict.size > 0 ? verdict : null
  } catch (err) {
    log?.debug(`jev gate: request failed: ${(err as Error).message}`)
    return null
  }
}
