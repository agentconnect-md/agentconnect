export const MAX_SKILL_BUNDLES = 64
export const MAX_SKILL_RECEIPT_FILES = 64
export const MAX_SKILL_PATH_BYTES = 1024
/** Byte ceilings for one installed skill, shared by every validator on the path — the CLI cell, the
 *  source snapshot, the install ledger's receipt check and the workspace mutation helper — so a
 *  bundle one stage admits is never refused by the next. Sized like the plugin ecosystems skills
 *  come from: Claude Code and Codex accept a 50 MB plugin (one CLI cell is one source, i.e. one
 *  plugin), and a file is capped at the cluster channel's 16 MiB so the sandbox upload can carry it. */
export const MAX_SKILL_FILE_BYTES = 16 * 1024 * 1024
export const MAX_SKILL_BUNDLE_BYTES = 50 * 1024 * 1024
