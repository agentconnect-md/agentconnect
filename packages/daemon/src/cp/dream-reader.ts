/**
 * `DreamReader` — the CP adapter answering the `memory/dream/*` REQs over the
 * daemon's `DreamRunner` (design: docs/designs/memory-dreaming.md §10). Job
 * METADATA is the only thing the CP may persist; staged store bodies transit
 * only as correlated replies, byte-sliced exactly like `memory/read`
 * (UTF-8 boundary + encoded-frame budget). Never log staged contents.
 */
import type {
  DreamStartReq,
  DreamCancelReq,
  DreamListReq,
  DreamListPage,
  DreamGetReq,
  DreamAdoptReq,
  DreamDiscardReq,
  DreamFilesReq,
  DreamFilesPage,
  DreamFileReadReq,
  DreamFileReadContent,
  DreamSkillReviewReq,
  DreamSkillReadReq,
  DreamSkillContent,
  DreamState,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionChunk,
  OrganizationSuggestionReviewReq,
  Ack
} from '@agentconnect.md/protocol'
import { fitToBudget, utf8Boundary } from '../wire-slice.js'
import type { DreamRunner } from '../agents/dream-runner.js'

export interface DreamReader {
  start(req: DreamStartReq): Promise<DreamState>
  cancel(req: DreamCancelReq): Promise<DreamState>
  list(req: DreamListReq): Promise<DreamListPage>
  get(req: DreamGetReq): Promise<DreamState>
  adopt(req: DreamAdoptReq): Promise<DreamState>
  discard(req: DreamDiscardReq): Promise<DreamState>
  files(req: DreamFilesReq): Promise<DreamFilesPage>
  fileRead(req: DreamFileReadReq): Promise<DreamFileReadContent>
  /** Full staged body of one candidate, so the console can show what accepting
   *  would install. Bounded by the miner's own caps; missing staging is DATA. */
  skillRead(req: DreamSkillReadReq): Promise<DreamSkillContent>
  skillAccept(req: DreamSkillReviewReq): Promise<DreamState>
  skillDismiss(req: DreamSkillReviewReq): Promise<DreamState>
  organizationSuggestionRead(req: OrganizationSuggestionReadReq): Promise<OrganizationSuggestionChunk>
  organizationSuggestionReview(req: OrganizationSuggestionReviewReq): Promise<Ack>
}

export function createDreamReader(runner: DreamRunner): DreamReader {
  return {
    async start(req) {
      return {
        dream: await runner.start(req.agentId, {
          trigger: req.trigger,
          ...(req.sessionWindow !== undefined ? { sessionWindow: req.sessionWindow } : {}),
          ...(req.instructions !== undefined ? { instructions: req.instructions } : {})
        })
      }
    },

    async cancel(req) {
      return { dream: runner.cancel(req.agentId, req.dreamId) }
    },

    async list(req) {
      return {
        agentId: req.agentId,
        dreams: req.pendingSkills
          ? runner.listPendingSkills(req.agentId, req.limit)
          : runner.list(req.agentId, req.limit)
      }
    },

    async get(req) {
      return { dream: runner.get(req.agentId, req.dreamId) }
    },

    async adopt(req) {
      return { dream: await runner.adopt(req.agentId, req.dreamId, req.force, req.reviewToken) }
    },

    async discard(req) {
      return { dream: await runner.discard(req.agentId, req.dreamId) }
    },

    async files(req) {
      const entries = await runner.stagedFiles(req.agentId, req.dreamId)
      const reviewToken = entries !== null ? await runner.stagedStoreReviewToken(req.agentId, req.dreamId) : null
      return {
        agentId: req.agentId,
        dreamId: req.dreamId,
        exists: entries !== null,
        entries: entries ?? [],
        ...(reviewToken !== null ? { reviewToken } : {})
      }
    },

    async fileRead(req) {
      const staged = await runner.stagedRead(req.agentId, req.dreamId, req.path)
      if (!staged) return { agentId: req.agentId, dreamId: req.dreamId, path: req.path, exists: false }
      const full = Buffer.from(staged.content, 'utf8')
      const size = full.length
      const want = Math.min(req.limit, Math.max(0, size - req.offset))
      const slice = full.subarray(req.offset, req.offset + want)
      const { end, content } = fitToBudget(slice, utf8Boundary(slice, slice.length))
      const nextOffset = req.offset + end
      return {
        agentId: req.agentId,
        dreamId: req.dreamId,
        path: req.path,
        exists: true,
        size,
        mtime: staged.mtime,
        content,
        offset: req.offset,
        nextOffset,
        truncated: nextOffset < size
      }
    },

    async skillRead(req) {
      const staged = await runner.stagedSkill(req.agentId, req.dreamId, req.name)
      if (!staged) return { agentId: req.agentId, dreamId: req.dreamId, name: req.name, exists: false }
      const reviewToken = await runner.stagedSkillReviewToken(req.agentId, req.dreamId, req.name)
      return {
        agentId: req.agentId,
        dreamId: req.dreamId,
        name: req.name,
        exists: true,
        ...staged,
        ...(reviewToken !== null ? { reviewToken } : {})
      }
    },
    async skillAccept(req) {
      return { dream: await runner.skillAccept(req.agentId, req.dreamId, req.name, req.reviewToken) }
    },

    async skillDismiss(req) {
      return { dream: await runner.skillDismiss(req.agentId, req.dreamId, req.name) }
    },

    async organizationSuggestionRead(req) {
      return runner.organizationSuggestionRead(req)
    },

    async organizationSuggestionReview(req) {
      return runner.organizationSuggestionReview(req)
    }
  }
}
