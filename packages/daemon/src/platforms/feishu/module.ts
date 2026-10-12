// Feishu/Lark's daemon platform module (§7.4): a person acts under an app-scoped open_id, so a synced organization matches them by their union_id.
import type { DaemonPlatformModule } from '../contract.js'

export const feishuPlatformModule: DaemonPlatformModule = {
  platformId: 'feishu',
  // An action without a union_id cannot be matched, and is refused rather than judged by the open_id.
  chatMemberKey: (actor) => actor.memberId
}
