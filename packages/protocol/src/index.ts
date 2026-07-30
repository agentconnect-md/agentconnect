/**
 * `@agentconnect.md/protocol` — the shared wire contract for the daemon ↔ CP
 * WebSocket protocol (daemon-cp-ws-protocol.md). Single source of truth for all
 * frames and the `sessionEpoch`/`seq`/`launchId` fencing fields, imported by
 * both the control-plane and the daemon.
 *
 * This barrel re-exports the zod schemas, their inferred types, and the
 * `isFrameType` guard.
 */

// ── cross-package wire + lifecycle constants ──
export {
  CP_SUBPROTOCOL,
  CP_WS_PATH,
  RESERVED_RESTART_CODE,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_VISIBILITY_FEATURE
} from './consts.js'

// ── envelope + control extension ──
export { Envelope, ControlExt, NIL_UUID } from './envelope.js'

// ── frame groups (schemas + inferred types) ──
export * from './frames/auth.js'
export * from './frames/register.js'
export * from './frames/collab.js'
export * from './frames/route.js'
export * from './frames/agent.js'
export * from './frames/cron.js'
export * from './frames/hook.js'
export * from './frames/integration.js'
export * from './frames/mcpserver.js'
export * from './frames/memory-connection.js'
export * from './frames/gitcred.js'
export * from './frames/secrets.js'
export * from './frames/session.js'
export * from './frames/channel.js'
export * from './frames/workspace.js'
export * from './frames/memory.js'
export * from './frames/telemetry.js'
export * from './frames/error.js'
export * from './frames/webchat.js'

// ── external-memory plugin ABI (daemon-private MCP profile; not a CP wire) ──
export * from './memory-plugin.js'

// ── the union, the type map, and guards ──
export { AnyFrame, FRAME_SCHEMAS, FRAME_TYPES, isFrameType } from './frame.js'
export type { FrameType } from './frame.js'

import { isFrameType, type FrameType, type AnyFrame } from './frame.js'

/**
 * Narrowing guard factory: `isFrame("auth")(frame)` narrows a decoded
 * `AnyFrame` to the member whose `type` matches.
 */
export function isFrame<T extends FrameType>(type: T) {
  return (frame: AnyFrame): frame is Extract<AnyFrame, { type: T }> => frame.type === type
}

/** Re-export under a convenience alias for call sites that prefer it. */
export { isFrameType as isKnownFrameType }

// ── wire codec (shared by daemon + control-plane) ──
export { decodeEnvelope, buildEnvelope, encode, MAX_FRAME_BYTES } from './codec.js'
export type { DecodeResult, BuildOpts, InboundControlExt } from './codec.js'

// ── relay wires (separate frame unions; shared-bot-relay.md §7/§8) ──
export * from './frames/relay-cp.js'
export * from './frames/relay-daemon.js'
export { decodeEnvelopeWith, buildEnvelopeRaw } from './wire.js'
export type { DecodeResultOf } from './wire.js'

// ── git repo address helpers (normalize on write, shorten for display) ──
export {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  MAX_GIT_REPO_LENGTH,
  GitCloneUrlError,
  normalizeAllowedWorkspaceGitUrl,
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  normalizeGitUrl,
  normalizeWorkspaceGitOrigin,
  redactGitUrlSecrets,
  gitRepoLabel,
  workspaceGitOriginOf
} from './git-url.js'

// ── Slack message visible-text extraction (shared by daemon + relay) ──
export { extractSlackMessageText } from './slack-message-text.js'
export type { SlackTextBearingMessage } from './slack-message-text.js'
export { isSlackSystemMessage } from './slack-system-message.js'

// ── repository-relative agent working-directory helpers ──
export { MAX_REPO_SUBDIR_LENGTH, RepoSubdirError, normalizeRepoSubdir } from './repo-subdir.js'
