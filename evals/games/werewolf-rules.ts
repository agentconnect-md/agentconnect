/**
 * Werewolf rules shared by BOTH compositions of the game:
 *
 *  - the Slack-shaped arena game (`werewolf.ts` — rooms, code referee via the
 *    trusted referee control path), and
 *  - the webchat single-conversation game (`webchat-werewolf.ts` — one
 *    multi-agent conversation, a scripted-subject referee acting through the
 *    real `sendMessage`/`needsReply` tool surface).
 *
 * Only the PURE pieces live here — the seeded role table, the stated-action
 * parser, and the win condition — so the two compositions cannot drift on the
 * rules while keeping their delivery mechanics separate.
 */
import { createHash } from 'node:crypto'

export type WerewolfRole = 'werewolf' | 'seer' | 'doctor' | 'villager'

export type WerewolfAction = 'vote' | 'inspect' | 'protect' | 'kill'

/** What the referee could read out of one message for one action. */
export type ParsedIntent =
  { kind: 'none' } | { kind: 'target'; target: string } | { kind: 'ambiguous'; targets: string[] }

/** Verbs that state each action. Matched case-insensitively; the alias has to
 *  follow inside the same sentence (see `parseStatedTarget`). */
export const ACTION_VERBS: Record<WerewolfAction, RegExp> = {
  vote: /\b(?:vote|votes|voting|voted|lynch|lynches|lynching)\b/gi,
  kill: /\b(?:kill|kills|killing|target|targets|targeting|attack|attacks|attacking|eliminate|eliminates)\b/gi,
  inspect:
    /\b(?:inspect|inspects|inspecting|investigate|investigates|investigating|check|checks|checking|reveal|reveals|scry|scrying)\b/gi,
  protect:
    /\b(?:protect|protects|protecting|save|saves|saving|guard|guards|guarding|shield|shields|shielding|heal|heals|healing)\b/gi
}

/**
 * Read one stated action out of a player's own words (see the Slack game's
 * header for the design rationale). Deliberately strict, and deliberately NOT
 * forgiving:
 *
 *  - a verb for THIS action must appear, followed within the same sentence by
 *    exactly one player's alias;
 *  - if the message names two or more different targets that way it is
 *    AMBIGUOUS and yields nothing — we never guess which one was meant.
 */
export function parseStatedTarget(text: string, action: WerewolfAction): ParsedIntent {
  const pattern = ACTION_VERBS[action]
  pattern.lastIndex = 0
  const targets = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    // The alias must follow the verb inside the same sentence; a verb at the
    // end of one sentence and a name at the start of the next is not intent.
    const from = match.index + match[0].length
    const named = /^[^.!?\n]*?\b(player-\d+)\b/.exec(text.slice(from, from + 80))
    if (named) targets.add(named[1]!)
  }
  if (targets.size === 0) return { kind: 'none' }
  if (targets.size > 1) return { kind: 'ambiguous', targets: [...targets].sort() }
  return { kind: 'target', target: [...targets][0]! }
}

/**
 * Size-appropriate wolf count. Two wolves at a five-player table degenerate:
 * one unsaved night-1 kill reaches parity instantly (2 wolves vs 2 others),
 * so every game is a one-night game with no day, vote, or later round —
 * measured across all real 5p runs. The table:
 *
 *  | players | werewolves |
 *  | ------- | ---------- |
 *  | 5–6     | 1          |
 *  | 7+      | 2          |
 */
export function werewolfWolfCount(playerCount: number): number {
  return playerCount >= 7 ? 2 : 1
}

/** The seeded role map — a pure function of (aliases, seed), shared by the
 *  topology builder (the Slack wolf den's membership depends on it) and both
 *  game compositions.
 *
 *  The table scales: {@link werewolfWolfCount} werewolves, one seer, one
 *  doctor, and villagers for the rest. */
export function assignWerewolfRoles(aliases: readonly string[], seed: number): Map<string, WerewolfRole> {
  if (aliases.length < 5) throw new Error('werewolf takes at least 5 players')
  const roles: WerewolfRole[] = [
    ...Array.from({ length: werewolfWolfCount(aliases.length) }, (): WerewolfRole => 'werewolf'),
    'seer',
    'doctor'
  ]
  while (roles.length < aliases.length) roles.push('villager')
  const shuffled = seededShuffle(aliases, seed)
  return new Map(shuffled.map((alias, index) => [alias, roles[index]!]))
}

/** Seeded Fisher–Yates: role assignment is a pure function of the seed. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = createHash('sha256').update(`werewolf-roles:${seed}`).digest().readUInt32BE(0) || 1
  const next = () => {
    // xorshift32 — deterministic, dependency-free.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** The win condition over the LIVING roles: village wins when no wolf lives;
 *  werewolves win at parity (`livingWolves >= livingOthers`). */
export function werewolfWinner(livingRoles: readonly WerewolfRole[]): 'village' | 'werewolves' | undefined {
  const livingWolves = livingRoles.filter((role) => role === 'werewolf').length
  const livingOthers = livingRoles.length - livingWolves
  if (livingWolves === 0) return 'village'
  if (livingWolves >= livingOthers) return 'werewolves'
  return undefined
}

/** Seeded per-run canaries for the two secrets the leak assertions watch. */
export function werewolfCanaries(seed: number): { wolf: string; seer: string } {
  return {
    wolf: `WOLF-CANARY-${seed}-${createHash('sha256').update(`wolf:${seed}`).digest('hex').slice(0, 8)}`,
    seer: `SEER-CANARY-${seed}-${createHash('sha256').update(`seer:${seed}`).digest('hex').slice(0, 8)}`
  }
}
