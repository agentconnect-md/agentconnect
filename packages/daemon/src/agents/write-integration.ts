/**
 * Persist CP-owned platform integrations onto the owning agent's on-disk
 * `agent.json`, which is the SINGLE SOURCE OF TRUTH — so integrations (and their
 * Slack tokens) survive a daemon restart with the Control Plane down (graceful
 * degradation: the daemon opens its Socket Mode connections from disk at start).
 *
 * Local hand-authored agents already store Slack tokens in `agent.json`
 * (agent-schema.ts SlackConfigSchema), so this adds no new secret-on-disk
 * concept. Tokens on disk are the same trust boundary as the daemon process;
 * they still MUST NEVER be logged.
 *
 * CRITICAL: like write-agent.ts, we operate on the RAW JSON TEXT (readFileSync →
 * JSON.parse → mutate only `integrations[]` → writeFileSync). We never serialize
 * the parsed `LoadedAgent`, whose `workspace.path` has been rewritten absolute.
 * Editing the raw file preserves the original relative path.
 */
import { readFileSync } from 'node:fs'
import type { IntegrationSpec } from '@agentconnect.md/protocol'
import type { Integration } from './agent-schema.js'
import { protectAgentJson, writeAgentJson } from './agent-json-file.js'
import { findAgentFiles } from './load-agents.js'
import { findAgentFileById } from './write-agent.js'

/** Map the wire spec to the daemon's `Integration` shape (agent-schema). */
function toIntegration(spec: IntegrationSpec): Integration {
  if (spec.platform === 'telegram') {
    return {
      id: spec.integrationId,
      origin: 'cp',
      platform: 'telegram',
      telegram: {
        botToken: spec.telegram.botToken,
        allowedUserIds: spec.telegram.allowedUserIds,
        bindRules: spec.telegram.bindRules
      }
    }
  }
  if (spec.platform === 'discord') {
    return {
      id: spec.integrationId,
      origin: 'cp',
      platform: 'discord',
      discord: {
        botToken: spec.discord.botToken,
        ...(spec.discord.applicationId ? { applicationId: spec.discord.applicationId } : {}),
        allowedUserIds: spec.discord.allowedUserIds,
        bindRules: spec.discord.bindRules
      }
    }
  }
  if (spec.platform === 'feishu') {
    return {
      id: spec.integrationId,
      origin: 'cp',
      platform: 'feishu',
      feishu: {
        appId: spec.feishu.appId,
        appSecret: spec.feishu.appSecret,
        ...(spec.feishu.botOpenId ? { botOpenId: spec.feishu.botOpenId } : {}),
        region: spec.feishu.region,
        allowedUserIds: spec.feishu.allowedUserIds,
        bindRules: spec.feishu.bindRules
      }
    }
  }
  return {
    id: spec.integrationId,
    origin: 'cp',
    platform: 'slack',
    slack: {
      mode: spec.slack.mode,
      // Multi-agent opt-in (shared mode only) — gates the in-thread "Switch agent" control.
      shareable: spec.slack.shareable,
      botToken: spec.slack.botToken,
      // Shared mode carries no appToken (the relay owns the event stream) but does
      // carry the CP-resolved botUserId; direct mode is the reverse.
      ...(spec.slack.appToken ? { appToken: spec.slack.appToken } : {}),
      ...(spec.slack.botUserId ? { botUserId: spec.slack.botUserId } : {}),
      allowedUserIds: spec.slack.allowedUserIds,
      bindRules: spec.slack.bindRules
    }
  }
}

export interface WriteIntegrationDeps {
  /** Warn sink for the orphan case (owning agent not on disk). */
  warn?: (msg: string) => void
}

/**
 * Upsert one integration into the owning agent's `agent.json` `integrations[]`
 * (replace by `integrationId`, else append). The owning agent is located by its
 * INTERNAL id (any directory layout). Returns false (with a warn) when no agent
 * with `spec.agentId` exists on disk — an orphan integration is not persisted;
 * it self-heals when the agent spec arrives and the CP re-sends (register/ok).
 */
export function writeIntegrationSpec(agentsDir: string, spec: IntegrationSpec, deps: WriteIntegrationDeps): boolean {
  const file = findAgentFileById(agentsDir, spec.agentId)
  if (!file) {
    // Log ids ONLY — never the token material.
    deps.warn?.(
      `cp: integration ${spec.integrationId} references missing agent ${spec.agentId} — not persisted (will retry on next push)`
    )
    return false
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const list: unknown[] = Array.isArray(raw.integrations) ? raw.integrations : []
  const next = toIntegration(spec)
  const idx = list.findIndex((i) => typeof i === 'object' && i !== null && (i as { id?: unknown }).id === next.id)
  if (idx >= 0) list[idx] = next
  else list.push(next)
  raw.integrations = list
  writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')
  return true
}

/**
 * Remove one integration (by id) from whichever agent.json holds it. Scans all
 * agent files since the owning agent is not part of `integration/remove`.
 * Returns whether an entry was found and removed. Unparseable files are skipped.
 */
export function removeIntegration(agentsDir: string, integrationId: string): boolean {
  for (const file of findAgentFiles(agentsDir)) {
    protectAgentJson(file)
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      continue // malformed agent.json can't hold the integration
    }
    if (!Array.isArray(raw.integrations)) continue
    const list = raw.integrations as unknown[]
    const idx = list.findIndex(
      (i) => typeof i === 'object' && i !== null && (i as { id?: unknown }).id === integrationId
    )
    if (idx === -1) continue
    list.splice(idx, 1)
    writeAgentJson(file, JSON.stringify(raw, null, 2) + '\n')
    return true
  }
  return false
}
