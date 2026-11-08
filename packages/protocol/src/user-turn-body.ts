// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.
import { z } from 'zod'

export const MESSAGE_ATTACHMENTS_MAX = 10

// Durable upload metadata; signed URLs and image previews stay outside this record.
export const UploadedFileReference = z.object({
  uploadId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\u0000-\u001f\u007f/\\]+$/, 'file name must not contain control characters or path separators'),
  mimeType: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/, 'must be a type/subtype MIME type'),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, { message: 'must be a base64 SHA-256' })
})
export type UploadedFileReference = z.infer<typeof UploadedFileReference>

export const MessageAttachmentSource = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('workspace'), path: z.string().trim().min(1).max(1024) }),
  z.strictObject({ source: z.literal('upload'), uploadId: z.string().uuid() }),
  z.strictObject({
    source: z.literal('platform'),
    platform: z.string().trim().min(1),
    integrationId: z.string().trim().min(1).optional(),
    fileId: z.string().trim().min(1).max(255)
  })
])
export type MessageAttachmentSource = z.infer<typeof MessageAttachmentSource>
export const PublishedAttachment = z.object({
  source: MessageAttachmentSource,
  name: z.string(),
  mimeType: z.string(),
  fileId: z.string().optional()
})
export type PublishedAttachment = z.infer<typeof PublishedAttachment>

/** The Linear facts behind one delegated or prompted turn — what the console formats, never instructions. */
export const LinearTurnFacts = z.object({
  event: z.enum(['created', 'prompted']).optional(),
  issue: z.object({
    identifier: z.string().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional()
  }),
  team: z.object({ id: z.string().optional(), key: z.string().optional(), name: z.string().optional() }).optional(),
  delegatedBy: z.string().optional(),
  /** The issue as Linear formatted it for the agent (`promptContext`), verbatim. */
  description: z.string().optional(),
  comments: z
    .array(z.object({ userId: z.string().optional(), body: z.string().optional(), createdAt: z.string().optional() }))
    .optional(),
  guidance: z.string().optional(),
  truncated: z.boolean().optional()
})
export type LinearTurnFacts = z.infer<typeof LinearTurnFacts>

/** The code-host facts behind one GitHub, GitLab, Gitea, or Azure DevOps delivery turn. */
export const CodehostTurnFacts = z.object({
  provider: z.enum(['github', 'gitlab', 'gitea', 'azure-devops']),
  event: z.string(),
  action: z.string().optional(),
  subject: z.object({
    kind: z.string().optional(), // issue | pull_request | merge_request | push | deployment | release
    repo: z.string().optional(),
    number: z.number().int().optional(),
    title: z.string().optional(),
    url: z.string().optional()
  }),
  author: z.object({ login: z.string().optional(), association: z.string().optional() }).optional(),
  labels: z.array(z.string()).optional(),
  revision: z.object({ base: z.string().optional(), head: z.string().optional() }).optional(),
  draft: z.boolean().optional(),
  ref: z.string().optional(),
  /** The target environment of a deployment delivery. */
  environment: z.string().optional(),
  /** The event body as delivered (an issue/PR description or a comment), already relay-bounded. */
  body: z.string().optional(),
  truncated: z.boolean().optional(),
  /** How this delivery is answered: a formal review generation, an inline review thread, or a plain reply. */
  review: z.enum(['generation', 'inline', 'conversation']).optional(),
  /** The repository routing verdict that chose this agent, read back from that scope's Recent evaluations. */
  routing: z
    .object({
      repoId: z.string(),
      family: z.enum(['issues', 'pull_request', 'merge_request']),
      decisionId: z.string(),
      verdictSeq: z.number().int().nonnegative()
    })
    .optional()
})
export type CodehostTurnFacts = z.infer<typeof CodehostTurnFacts>

/** The trusted facts behind one session message (an agent call, a reply, a task's input or report), shown folded under its body. */
export const SessionMessageTurnFacts = z.object({
  /** Absent on a daemon report that lands where it is no session message. */
  messageId: z.string().optional(),
  kind: z.enum(['call', 'reply', 'report', 'taskInput']),
  source: z.object({ agentId: z.string(), label: z.string().optional(), sessionId: z.string().optional() }),
  inReplyTo: z.string().optional(),
  replyRequested: z.boolean().optional(),
  startsTask: z.boolean().optional(),
  /** The guidance the model received around the body, verbatim, in order. */
  notes: z.array(z.string()).optional()
})
export type SessionMessageTurnFacts = z.infer<typeof SessionMessageTurnFacts>

/** The task a coordinator's post links to (auto-session-mode.md §10): the console draws it as a card that opens the task's thread. */
export const TaskLinkFacts = z.object({
  /** The task's outward session id. */
  sessionId: z.string().min(1).max(200),
  title: z.string().max(300),
  /** `opened` started the task for the message; `handed` passed the message to one already running. */
  how: z.enum(['opened', 'handed'])
})
export type TaskLinkFacts = z.infer<typeof TaskLinkFacts>

// JSON in SessionMessage.body: the model's prompt when it differs from text, plus facts the console renders.
export const UserTurnBody = z.object({
  prompt: z.string().optional(),
  uploads: z.array(UploadedFileReference).max(MESSAGE_ATTACHMENTS_MAX).optional(),
  publishedAttachments: z.array(PublishedAttachment).max(MESSAGE_ATTACHMENTS_MAX).optional(),
  linear: LinearTurnFacts.optional(),
  codehost: CodehostTurnFacts.optional(),
  sessionMessage: SessionMessageTurnFacts.optional(),
  /** On a coordinator's own post: the task it links to. */
  taskLink: TaskLinkFacts.optional(),
  /** On a coordinator's own post in a thread: a message of that thread, not output of the turn that posted it (webchat-threads.md §6). */
  threadPost: z.literal(true).optional()
})
export type UserTurnBody = z.infer<typeof UserTurnBody>
