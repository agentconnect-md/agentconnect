import { currentSkillMutationHelperLease } from '../../src/skills/skill-workspace-lock-lease.js'
import { withSkillWorkspaceLock } from '../../src/skills/skill-install-ledger.js'
import { installSkills } from '../../src/skills/install-skills.js'

const [mode, cwd, stateDir, helperPgidArg] = process.argv.slice(2)
if (!mode || !cwd || !stateDir || !process.send) throw new Error('invalid skill lock worker invocation')

const notify = (message: Record<string, unknown>): void => {
  process.send?.(message)
}

if (mode === 'claim') {
  try {
    await installSkills({ id: helperPgidArg!, runtime: 'claude', skills: [] }, cwd, { stateDir })
    notify({ type: 'claimed', agentId: helperPgidArg })
  } catch (error) {
    notify({ type: 'claim-error', error: error instanceof Error ? error.message : String(error) })
  }
  process.disconnect?.()
} else {
  await withSkillWorkspaceLock(
    cwd,
    async () => {
      if (mode === 'helper-crash') {
        const lease = currentSkillMutationHelperLease()
        if (!lease) throw new Error('missing mutation-helper lease')
        const helperPgid = Number(helperPgidArg)
        if (!Number.isSafeInteger(helperPgid) || helperPgid <= 0) throw new Error('missing helper pgid')
        await lease.registerHelper(helperPgid)
        notify({ type: 'helper', pgid: helperPgid })
        process.exit(0)
      }

      notify({ type: 'locked' })
      await new Promise<void>((resolve) => {
        process.on('message', (message) => {
          if (message === 'release') resolve()
        })
      })
    },
    stateDir
  )

  notify({ type: 'done' })
  process.disconnect?.()
}
