// Vendored subset of `onebots` core (lc-cn/onebots, MIT) — only the symbols the
// iLink SDK needs. Upstream: adapters/adapter-wechat-clawbot peer-depends on the
// full onebots gateway (react/ink/nodemailer), which is too heavy to depend on.
export { ErrorCategory, ErrorSeverity, OneBotsError } from './errors.js'
export { materializeMediaSource } from './media-source.js'
export { readPackageVersionFile } from './package-metadata.js'
export { RecentEventDeduplicator } from './recent-event-deduplicator.js'
