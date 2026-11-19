// Whether Email is offered, and whether an address name is free (email-integration.md §3.1).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../../http/plugins/zod.js'
import { Tag } from '../../http/plugins/openapi.js'
import type { EmailAddressRepo } from '../../persistence/ports.js'
import { emailAddressFor } from './provider.js'

export interface EmailRouteSeams {
  /** The deployment's mail domain; absent ⇒ Email is not offered. */
  mailDomain?: string
  addresses: Pick<EmailAddressRepo, 'taken'>
}

const EmailAddressQuery = z.object({
  name: z.string().trim().min(1).max(64).optional().describe('The address name to check, the part before the @.')
})

const EmailAddressDto = z.object({
  mailDomain: z
    .string()
    .nullable()
    .describe('The domain every agent address is on; null when the deployment has not set Email up.'),
  address: z.string().nullable().describe('The full address the name would give; null when the name cannot be one.'),
  available: z.boolean().describe('Whether an integration can take this name now; false when no name was given.'),
  reason: z
    .enum(['not_configured', 'length', 'characters', 'reserved', 'taken'])
    .nullable()
    .describe('Why a given name is unavailable; `taken` covers an address in use and one used before.')
})

export function emailAddressRoutes(email: EmailRouteSeams) {
  return async function emailAddressRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/integrations/email/address',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check an email address name',
          description:
            'The mail domain this deployment gives agents addresses on, or null when Email is not set up. With a `name`, also whether an Email integration can take it: a name is 3 to 40 lower-case letters, digits, dots and hyphens, role names such as `postmaster` are reserved, and an address is unique in the deployment and never issued twice, so one that any organization uses or used before is taken.',
          operationId: 'checkEmailAddressName',
          querystring: EmailAddressQuery,
          response: { 200: EmailAddressDto }
        }
      },
      async (req) => {
        const mailDomain = email.mailDomain ?? null
        if (req.query.name === undefined) return { mailDomain, address: null, available: false, reason: null }
        const named = emailAddressFor(req.query.name, email.mailDomain)
        if (!named.ok) return { mailDomain, address: null, available: false, reason: named.reason }
        const taken = await email.addresses.taken(named.address)
        return { mailDomain, address: named.address, available: !taken, reason: taken ? ('taken' as const) : null }
      }
    )
  }
}
