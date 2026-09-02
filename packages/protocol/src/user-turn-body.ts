// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.
import { z } from 'zod'

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

/** The code-host facts behind one GitHub or GitLab delivery turn. */
export const CodehostTurnFacts = z.object({
  provider: z.enum(['github', 'gitlab']),
  event: z.string(),
  action: z.string().optional(),
  subject: z.object({
    kind: z.string().optional(), // issue | pull_request | merge_request | push
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
  /** The event body as delivered (an issue/PR description or a comment), already relay-bounded. */
  body: z.string().optional(),
  truncated: z.boolean().optional(),
  /** How this delivery is answered: a formal review generation, an inline review thread, or a plain reply. */
  review: z.enum(['generation', 'inline', 'conversation']).optional()
})
export type CodehostTurnFacts = z.infer<typeof CodehostTurnFacts>

/**
 * What lies behind one user-turn `text` row, transported as a JSON STRING in `SessionMessage.body`.
 * `prompt` is the text the model actually received when it differs from the row's `text` (replay
 * reads it); the platform facts are what the console renders behind the bubble. Absent on rows
 * from before it existed and on turns whose prompt IS the text.
 */
export const UserTurnBody = z.object({
  prompt: z.string().optional(),
  linear: LinearTurnFacts.optional(),
  codehost: CodehostTurnFacts.optional()
})
export type UserTurnBody = z.infer<typeof UserTurnBody>
