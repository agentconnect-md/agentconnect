import { z } from 'zod'
import { FollowUpEventKind, FollowUpWatchSubject } from './follow-up-watch.js'

export const CODEHOST_FEEDBACK_FEATURE = 'codehost-feedback-v1'

const Provider = z.enum(['gitlab', 'gitea'])
const RepoId = z.string().regex(/^[1-9]\d*$/)

// A repository subscription has no trigger, agent, prompt, or review authority; never log its signing keys.
export const RcCodeHostFeedbackWatch = z.object({
  provider: Provider,
  repoId: RepoId,
  watch: z
    .object({
      orgId: z.string().min(1),
      bindingId: z.string().uuid(),
      host: z.string().url(),
      signingKey: z.string().min(1),
      nextSigningKey: z.string().min(1).optional(),
      // Follow-ups watch objects here (assistant-mode.md §5.14), so the relay also sends their wake-only events.
      followUps: z.literal(true).optional()
    })
    .optional()
})
export type RcCodeHostFeedbackWatch = z.infer<typeof RcCodeHostFeedbackWatch>

// Only verified event coordinates cross this boundary; the daemon reads feedback bodies and logs.
export const RcCodeHostFeedback = z
  .object({
    provider: Provider,
    orgId: z.string().min(1),
    bindingId: z.string().uuid(),
    host: z.string().url(),
    repoId: RepoId,
    deliveryKey: z.string().min(1).max(200),
    pullNumber: z.number().int().positive().optional(),
    headSha: z
      .string()
      .regex(/^[a-fA-F0-9]{40,64}$/)
      .optional(),
    actorId: RepoId.optional(),
    actorUsername: z.string().min(1).max(255).optional(),
    // `event` is any other change on an object, sent wake-only (assistant-mode.md §5.14).
    kind: z.enum(['comment', 'ci', 'event']),
    // What happened and on which kind of object; a `wakeOnly` signal wakes follow-ups alone.
    subject: FollowUpWatchSubject.optional(),
    event: FollowUpEventKind.optional(),
    wakeOnly: z.literal(true).optional()
  })
  .refine((value) => (value.kind === 'ci' ? value.headSha !== undefined : value.pullNumber !== undefined))
  .refine((value) => value.wakeOnly === true || (value.kind !== 'event' && value.subject !== 'issue'), {
    message: 'an issue or other object event wakes follow-ups only'
  })
export type RcCodeHostFeedback = z.infer<typeof RcCodeHostFeedback>

export const RcCodeHostFeedbackResult = z.object({
  accepted: z.boolean(),
  authorAgentIds: z.array(z.string().uuid())
})
export type RcCodeHostFeedbackResult = z.infer<typeof RcCodeHostFeedbackResult>
