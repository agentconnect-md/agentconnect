import { z } from 'zod'
import { CODE_HOST_PROVIDERS } from './code-host.js'

/** A linked person's commit identity, scoped to the code host that recognizes it. */
export const CommitAuthor = z.object({
  provider: z.enum(CODE_HOST_PROVIDERS),
  host: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\x00-\x1f\x7f<>]+$/),
  email: z.string().email().max(320)
})
export type CommitAuthor = z.infer<typeof CommitAuthor>

/** Attribution only: neither a permission grant nor proof that a commit was written by this person. */
export const TaskInitiator = z.object({
  name: z.string().min(1).max(256),
  commitAuthors: z.array(CommitAuthor).max(8)
})
export type TaskInitiator = z.infer<typeof TaskInitiator>
