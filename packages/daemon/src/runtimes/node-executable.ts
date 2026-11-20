import { realpathSync } from 'node:fs'

/** The symlink-resolved Node running this daemon, or an error naming the fix once a package upgrade has removed it. */
export function nodeExecutable(execPath: string = process.execPath): string {
  try {
    return realpathSync(execPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    throw new Error(
      `The Node.js this daemon started from is gone (${execPath}), most likely after an upgrade. Restart the daemon; for a background service run \`agentconnect install-service\` and then \`agentconnect restart\`.`,
      { cause: err }
    )
  }
}
