import { z } from 'zod'
import { CodeHostExternalId, CodeHostProviderString } from '../code-host.js'

// The CP answers `repo-candidates/request`; a daemon sends it only after seeing this (multi-repository-workspaces.md, The selector).
export const REPO_CANDIDATES_V1_FEATURE = 'repo-candidates-v1'
// The daemon selects a session's `decision` repositories before it starts (decisions 15–19); the CP refuses `decision` for a daemon without it.
export const REPO_SELECTOR_V1_FEATURE = 'repo-selector-v1'
// At most this many candidates in one reply, across every grant.
export const REPO_CANDIDATES_MAX = 512
// A longer description is cut to this many characters before it is sent.
export const REPO_CANDIDATE_DESCRIPTION_MAX = 350

// D→C REQ: the rosters of the agent's installation grants marked `decision`; its repository rows already ride the spec.
export const RepoCandidatesRequest = z.object({ agentId: z.string().uuid() })
export type RepoCandidatesRequest = z.infer<typeof RepoCandidatesRequest>

// One covered repository: its names, numeric id, and what the host publishes about it; control metadata, never message content.
export const RepoCandidate = z.object({
  provider: CodeHostProviderString,
  repoFullName: z.string().min(1).max(256),
  repoId: CodeHostExternalId,
  description: z.string().max(REPO_CANDIDATE_DESCRIPTION_MAX).optional(),
  pushedAt: z.string().datetime().optional()
})
export type RepoCandidate = z.infer<typeof RepoCandidate>

// C→D REP: most recently pushed first; `partial` when a bound cut the rosters short.
export const RepoCandidatesReply = z.object({
  candidates: z.array(RepoCandidate).max(REPO_CANDIDATES_MAX),
  partial: z.boolean()
})
export type RepoCandidatesReply = z.infer<typeof RepoCandidatesReply>
