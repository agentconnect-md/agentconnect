export type WeixinProtocol = typeof import('./vendor/sdk/ilink-bot.js')

let protocol: Promise<WeixinProtocol> | undefined

/** Load the vendored iLink SDK only when a Weixin connection is actually used. */
export function loadWeixinProtocol(): Promise<WeixinProtocol> {
  return (protocol ??= import('./vendor/sdk/ilink-bot.js'))
}
