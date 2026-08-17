/**
 * `@agentconnect.md/protocol` — shared daemon, relay, and Control Plane wire
 * contracts. Single source of truth for normalized message schemas, frames,
 * and the `sessionEpoch`/`seq`/`launchId` fencing fields.
 *
 * This barrel re-exports the zod schemas, their inferred types, and the
 * `isFrameType` guard.
 */

// ── cross-package wire + lifecycle constants ──
export {
  AGENT_CONFIG_REVISION_FEATURE,
  AGENT_WAKE_FEATURE,
  DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
  DAEMON_BOOTSTRAP_UPGRADE_FEATURE,
  CLOUD_DAEMON_SA_NAME,
  CP_IDENTITY_TOKEN_PATH,
  CP_SUBPROTOCOL,
  CP_TOKEN_AUDIENCE,
  CP_URL_ENV,
  USAGE_COLLECTOR_SA_NAME,
  POD_TEMPLATE_HASH_ENV,
  CP_WS_PATH,
  hasReachedAgentCallHopLimit,
  MAX_AGENT_CALL_HOPS,
  MAX_ENVIRONMENT_VALUE_LENGTH,
  WEBCHAT_MULTI_AGENT_FEATURE,
  WEBCHAT_REMOTE_MCP_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE,
  RESERVED_RESTART_CODE,
  K8S_SUPERVISOR,
  AGENT_EXISTS_FEATURE,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_METADATA_ACK_FEATURE,
  SESSION_PURGE_FEATURE,
  SESSION_VISIBILITY_FEATURE,
  SLACK_SESSION_AUDIENCE_FEATURE,
  TASK_LIST_FEATURE,
  WORKSPACE_GIT_MESSAGE_BUDGET_MS,
  WORKSPACE_GIT_MESSAGE_FEATURE,
  WORKSPACE_GIT_REVIEW_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE
} from './consts.js'

// ── normalized platform-message wire contract ──
export * from './normalized-message.js'

// ── envelope + control extension ──
export { Envelope, ControlExt, NIL_UUID } from './envelope.js'

// ── frame groups (schemas + inferred types) ──
export * from './frames/auth.js'
export * from './frames/register.js'
export * from './frames/collab.js'
export * from './frames/route.js'
export * from './frames/agent.js'
export * from './frames/cron.js'
export * from './frames/duty.js'
export * from './frames/hook.js'
export * from './frames/integration.js'
export * from './frames/mcpserver.js'
export * from './frames/memory-connection.js'
export * from './frames/skill.js'
export * from './frames/gitcred.js'
export * from './frames/secrets.js'
export * from './frames/session.js'
export * from './frames/channel.js'
export * from './frames/workspace.js'
export * from './frames/task.js'
export * from './frames/memory.js'
export * from './frames/organization-knowledge.js'
export * from './frames/telemetry.js'
export * from './frames/error.js'
export * from './frames/webchat.js'
export * from './frames/remote-mcp.js'

// ── external-memory plugin ABI (daemon-private MCP profile; not a CP wire) ──
export * from './memory-plugin.js'

// ── key-server contract (daemon-only HTTP client seam; not a CP wire) ──
export * from './key-server.js'

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

// ── which frames carry an organization (k8s-daemon-pool.md M4) ──
export {
  INSTALL_WIDE_FRAME_TYPES,
  GENERIC_REPLY_FRAME_TYPES,
  isInstallWideFrameType,
  checkInboundFrameOrg,
  checkReplyFrameOrg
} from './frame-scope.js'
export type { OrganizationMode, FrameOrgPeer, FrameOrgRef, FrameOrgVerdict } from './frame-scope.js'

// ── relay wires (separate frame unions; shared-bot-relay.md §7/§8) ──
export * from './frames/relay-cp.js'
// Manifest-declared Slack shortcut id — defined in the bundler-facing
// `./slack-app-manifest.ts` leaf, re-exported here so the package root keeps
// serving it next to the runtime Slack action ids above.
export { SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID } from './slack-app-manifest.js'
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
  normalizeGitHubSkillSource,
  normalizeGithubRepoUrl,
  normalizeGitUrl,
  normalizeWorkspaceGitOrigin,
  redactGitUrlSecrets,
  gitRepoLabel,
  workspaceGitOriginOf
} from './git-url.js'

// ── repository-relative agent working-directory helpers ──
export { MAX_REPO_SUBDIR_LENGTH, RepoSubdirError, normalizeRepoSubdir } from './repo-subdir.js'

// ── §5 platform manifest — pre-dispatch capability table, read by every host ──
export { DEFAULT_MANIFEST, manifestFor } from './platform-manifest.js'
export type { MembershipEnumeration, PlatformManifest } from './platform-manifest.js'
