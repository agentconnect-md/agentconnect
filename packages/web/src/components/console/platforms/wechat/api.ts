// No 'use client' here: reached only from ModalProvider's tree and the Settings view, both client trees.

import { getWeChatLogin, startWeChatLogin, type WeChatLoginDto } from '@/lib/api'

// The WeChat module's own CP client surface ({@link WebPlatformModule.apiBindings}); the QR login is its only install path.
export const weChatApi = {
  startLogin: startWeChatLogin,
  getLogin: getWeChatLogin
}

export type WeChatApi = typeof weChatApi
export type { WeChatLoginDto }
