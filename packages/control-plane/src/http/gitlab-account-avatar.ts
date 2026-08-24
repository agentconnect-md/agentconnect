import { GITLAB_AVATAR_SIZE } from '../gitlab/api.js'
import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'

/** Render the agent's icon as the square PNG its GitLab account wears
 *  (gitlab-com-integration.md §7.2). Re-encoded rather than passed through so an
 *  uploaded image cannot exceed GitLab's 200 KB avatar ceiling. */
export function createGitlabAccountAvatarRenderer(iconStore?: IconStore) {
  return async (agent: BotProfileIconAgent): Promise<Uint8Array> => {
    const source = await loadBotProfileIcon(agent, iconStore, GITLAB_AVATAR_SIZE)
    const { default: sharp } = await import('sharp')
    const png = await sharp(source.bytes)
      .resize(GITLAB_AVATAR_SIZE, GITLAB_AVATAR_SIZE, { fit: 'cover' })
      .png()
      .toBuffer()
    return new Uint8Array(png)
  }
}
