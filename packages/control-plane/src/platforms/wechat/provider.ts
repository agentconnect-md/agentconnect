// Personal WeChat's Control Plane provider (wechat-integration.md §2, §6): a QR login installs the bot; nothing is pasted.
import { z, type ZodRawShape } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { IntegrationWeChatConfig } from '@agentconnect.md/protocol'
import type { CpPlatformProvider } from '../provider.js'
import type { WeChatConfirmedLogin } from './login.js'
import { WECHAT_DEFAULT_API_URL } from './ilink.js'

export const WECHAT_PLATFORM_ID = 'wechat'

/** How long a login row (and any token it held) may linger after it was created. */
export const WECHAT_LOGIN_REAP_AFTER_MS = 30 * 60 * 1000

export const WeChatCpEnvSchema = {
  WECHAT_API_URL: z.string().url().optional()
} satisfies ZodRawShape

/** No credential block is accepted on the generic create route: only a QR login proves who the counterpart is. */
export const WeChatCreateCredentials = z.object({}).strict()
type Credentials = z.infer<typeof WeChatCreateCredentials>

/** The public row metadata a login writes: the iLink bot id, the scanner's WeChat id, and the member who scanned. */
export function weChatBotIdentity(login: WeChatConfirmedLogin): Record<string, string> {
  return {
    wechatBotId: login.ilinkBotId,
    wechatUserId: login.ilinkUserId,
    boundMemberUserId: login.createdByUserId,
    ...(login.baseUrl && /^https:\/\//.test(login.baseUrl) ? { wechatApiUrl: login.baseUrl } : {})
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

export interface WeChatCpProviderDeps {
  apiUrl?: string
  routes?: FastifyPluginAsync[]
  logins?: { reapExpired(staleBefore: Date): Promise<number> }
  reapIntervalMs?: number
}

export function createWeChatCpProvider(deps: WeChatCpProviderDeps): CpPlatformProvider<Credentials> {
  return {
    platformId: WECHAT_PLATFORM_ID,
    envSchema: WeChatCpEnvSchema,
    installRoutes: (scope) => (scope === 'org' ? (deps.routes ?? []) : []),
    credentialBodySchema: WeChatCreateCredentials,
    validateConfig: async () => ({
      ok: false,
      status: 400,
      code: 'WECHAT_QR_LOGIN_REQUIRED',
      message: 'WeChat is connected by scanning a QR code from the agent’s integrations, not with pasted credentials.'
    }),
    buildNewBotInstall: () => ({ secrets: { botToken: '', appToken: null, signingSecret: null } }),
    // The demux identity changes on every re-scan (§2.3), so only public metadata is kept, never a fenced key.
    projectBotIdentity: (input) => (input.platformConfig ? { platformConfig: input.platformConfig } : {}),
    // A WeChat bot is one person's chat with one agent: removing its install deletes it rather than freeing it for reuse.
    releasesFreedBot: () => true,
    secretShape: { slots: { botToken: 'iLink bot token', appToken: 'iLink bot id' }, httpAssignRequires: [] },
    ...(deps.logins
      ? {
          pendingInstalls: [
            {
              model: 'WechatPendingLogin',
              label: 'wechat-login',
              store: deps.logins,
              ttlMs: WECHAT_LOGIN_REAP_AFTER_MS,
              intervalMs: deps.reapIntervalMs ?? 60_000
            }
          ]
        }
      : {}),
    async projectIntegrationConfig(_integration, bot, _core, secrets): Promise<IntegrationWeChatConfig | undefined> {
      const boundUserId = text(bot.platformConfig?.wechatUserId)
      if (!secrets.botToken || !secrets.appToken || !boundUserId) return undefined
      const apiUrl = deps.apiUrl ?? text(bot.platformConfig?.wechatApiUrl)
      return {
        botId: secrets.appToken,
        botToken: secrets.botToken,
        boundUserId,
        ...(apiUrl && apiUrl !== WECHAT_DEFAULT_API_URL ? { apiUrl } : {})
      }
    }
  }
}
