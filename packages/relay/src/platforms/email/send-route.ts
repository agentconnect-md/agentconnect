// The ticketed post of a started mail with attachments (email-integration.md §6.4): the files ride HTTP, never a relay frame.
import type { FastifyInstance } from 'fastify'
import { EMAIL_SEND_BODY_MAX_BYTES, EMAIL_SEND_PATH, type RcEmailDeployment } from '@agentconnect.md/protocol'
import type { EmailRelayEgress } from './egress.js'

export interface EmailSendRouteDeps {
  config: () => RcEmailDeployment | undefined
  egress: Pick<EmailRelayEgress, 'redeemSend'>
}

/** Mount `POST /email/send/<ticket>`, which answers the `rd/platform/reply` a frame would have carried; the ticket is the only credential, so the route logs no URL. */
export function registerEmailSendRoute(app: FastifyInstance, deps: EmailSendRouteDeps): void {
  app.post<{ Params: { '*': string } }>(
    `${EMAIL_SEND_PATH}/*`,
    { logLevel: 'warn', bodyLimit: EMAIL_SEND_BODY_MAX_BYTES },
    async (req, reply) => {
      const config = deps.config()
      const answer = config ? await deps.egress.redeemSend(config, req.params['*'], req.body) : undefined
      // An unknown, expired or foreign ticket, and a relay that serves no mail, answer alike.
      if (!answer) return reply.code(404).send()
      return reply.header('cache-control', 'no-store').send(answer)
    }
  )
}
