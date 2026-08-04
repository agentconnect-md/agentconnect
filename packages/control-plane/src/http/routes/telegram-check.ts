/**
 * `POST /integrations/telegram/check` — the pre-install CREDENTIAL PROBE: report
 * whether a pasted BotFather token is valid and whether Group Privacy Mode is
 * disabled, WITHOUT storing anything. The console calls it while the operator is
 * still typing, so the Privacy-Mode fix (a BotFather round-trip that cannot be
 * automated) is surfaced before `POST /integrations` refuses the install.
 *
 * A PROVIDER-CONTRIBUTED org route (integration-plugin-architecture.md §9
 * `installRoutes('org')`). It was the last per-platform route inside core
 * `http/routes/integrations.ts` and the last core reader of
 * `deps.verifyTelegramBot`. The path is unchanged: `integrationRoutes` and the
 * registry's org plugins register into the same `/api/v1/orgs/:orgId` scope
 * (pinned in `http/platform-route-mounts.test.ts`).
 *
 * NO OTHER PLATFORM HAS AN EQUIVALENT, and none should grow one by copying this
 * shape. Telegram is the only platform whose credential carries an operator-
 * fixable *account setting* that the install cannot repair for them: Discord's
 * comparable gate (the Message-Content intent) is ENABLED by the CP during
 * `validateConfig`, and Slack's / Feishu's checks only tell you the token is
 * wrong — which the create call already tells you, with the same copy, one step
 * later. A generic "probe these credentials" route would have to return the
 * §9 `CpConfigValidation` union verbatim, which is the create route's own
 * pre-store contract; that is a §15 consolidation, not this unit.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { TelegramRouteSeams } from '../platform-route-seams.js'
import { denyViewerWrite } from '../rbac.js'
import { TelegramBotCheckBody, TelegramBotCheckDto, ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

export function telegramCheckRoutes(_deps: HttpDeps, telegram: TelegramRouteSeams) {
  return async function telegramCheckRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/integrations/telegram/check',
      {
        schema: {
          tags: [Tag.Integrations],
          summary: 'Check a Telegram bot',
          description:
            'Validate a pasted Telegram bot token and report whether Group Privacy Mode is disabled, without storing the token.',
          operationId: 'checkTelegramBot',
          body: TelegramBotCheckBody,
          response: { 200: TelegramBotCheckDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const checked = await telegram.verifyBot(req.body.botToken)
        return {
          status:
            checked.status === 'ok'
              ? checked.privacyModeDisabled
                ? ('ready' as const)
                : ('privacy_enabled' as const)
              : checked.status
        }
      }
    )
  }
}
