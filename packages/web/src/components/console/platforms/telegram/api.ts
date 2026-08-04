// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { checkTelegramBot } from '@/lib/api'

/**
 * The Telegram module's own CP client surface
 * ({@link WebPlatformModule.apiBindings}) — one call: validate a pasted token and
 * its Group Privacy Mode without storing it. OPAQUE to the chassis.
 */
export const telegramApi = { checkBot: checkTelegramBot }

export type TelegramApi = typeof telegramApi
