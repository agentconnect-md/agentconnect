import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stringify } from 'yaml'

import { lockfileClosureChanged } from './lockfile-closure-changed.mjs'

const DAEMON_IMPORTERS = ['packages/daemon', 'packages/message', 'packages/protocol', 'packages/connection']
const CLI_IMPORTERS = ['packages/cli', 'packages/protocol', 'packages/connection']

// A miniature v9 lockfile shaped like the real one: root + web importers that
// the daemon check must ignore, workspace links, a peer-suffixed dep path,
// and a dev dep that shapes the daemon build (tsdown → typescript).
const baseLock = () => ({
  lockfileVersion: '9.0',
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  importers: {
    '.': {
      devDependencies: { 'semantic-release': { specifier: '^25.0.5', version: '25.0.5' } }
    },
    'packages/connection': {
      dependencies: {
        '@agentconnect.md/protocol': { specifier: 'workspace:*', version: 'link:../protocol' },
        ws: { specifier: '^8.21.0', version: '8.21.0' }
      }
    },
    'packages/cli': {
      dependencies: {
        '@agentconnect.md/connection': { specifier: 'workspace:*', version: 'link:../connection' },
        '@agentconnect.md/protocol': { specifier: 'workspace:*', version: 'link:../protocol' }
      },
      devDependencies: {
        tsdown: { specifier: '^0.22.3', version: '0.22.3(typescript@6.0.3)' }
      }
    },
    'packages/daemon': {
      dependencies: {
        '@agentconnect.md/connection': { specifier: 'workspace:*', version: 'link:../connection' },
        '@agentconnect.md/message': { specifier: 'workspace:*', version: 'link:../message' },
        '@agentconnect.md/protocol': { specifier: 'workspace:*', version: 'link:../protocol' },
        zod: { specifier: '^4.4.3', version: '4.4.3' }
      },
      devDependencies: {
        tsdown: { specifier: '^0.22.3', version: '0.22.3(typescript@6.0.3)' }
      }
    },
    'packages/message': {
      dependencies: {
        '@agentconnect.md/protocol': { specifier: 'workspace:*', version: 'link:../protocol' }
      },
      devDependencies: {
        typescript: { specifier: '^6.0.3', version: '6.0.3' }
      }
    },
    'packages/protocol': {
      dependencies: { zod: { specifier: '^4.4.3', version: '4.4.3' } }
    },
    'packages/web': {
      dependencies: {
        'lucide-react': { specifier: '^0.500.0', version: '0.500.0(react@19.0.0)' }
      }
    }
  },
  packages: {
    'lucide-react@0.500.0': { resolution: { integrity: 'sha512-lucide' } },
    'react@19.0.0': { resolution: { integrity: 'sha512-react' } },
    'semantic-release@25.0.5': { resolution: { integrity: 'sha512-semrel' } },
    'tsdown@0.22.3': { resolution: { integrity: 'sha512-tsdown' } },
    'typescript@6.0.3': { resolution: { integrity: 'sha512-ts' } },
    'ws@8.21.0': { resolution: { integrity: 'sha512-ws' } },
    'zod@4.4.3': { resolution: { integrity: 'sha512-zod' } }
  },
  snapshots: {
    'lucide-react@0.500.0(react@19.0.0)': { dependencies: { react: '19.0.0' } },
    'react@19.0.0': {},
    'semantic-release@25.0.5': {},
    'tsdown@0.22.3(typescript@6.0.3)': { dependencies: { typescript: '6.0.3' } },
    'typescript@6.0.3': {},
    'ws@8.21.0': {},
    'zod@4.4.3': {}
  }
})

const changed = (mutate, importerDirs = DAEMON_IMPORTERS) => {
  const head = baseLock()
  mutate(head)
  return lockfileClosureChanged(stringify(baseLock()), stringify(head), importerDirs)
}

test('identical lockfiles are unchanged', () => {
  assert.equal(lockfileClosureChanged(stringify(baseLock()), stringify(baseLock()), DAEMON_IMPORTERS), false)
})

test('web-only dependency bump does not affect the daemon closure', () => {
  assert.equal(
    changed((lock) => {
      lock.importers['packages/web'].dependencies['lucide-react'] = {
        specifier: '^0.501.0',
        version: '0.501.0(react@19.0.0)'
      }
      delete lock.packages['lucide-react@0.500.0']
      delete lock.snapshots['lucide-react@0.500.0(react@19.0.0)']
      lock.packages['lucide-react@0.501.0'] = { resolution: { integrity: 'sha512-lucide2' } }
      lock.snapshots['lucide-react@0.501.0(react@19.0.0)'] = { dependencies: { react: '19.0.0' } }
    }),
    false
  )
})

test('root devDependency bump does not affect the daemon closure', () => {
  assert.equal(
    changed((lock) => {
      lock.importers['.'].devDependencies['semantic-release'].version = '25.0.6'
      lock.packages['semantic-release@25.0.6'] = { resolution: { integrity: 'sha512-semrel2' } }
      lock.snapshots['semantic-release@25.0.6'] = {}
    }),
    false
  )
})

test('message-only dependency bump does not affect the CLI closure', () => {
  assert.equal(
    changed((lock) => {
      lock.importers['packages/message'].devDependencies.typescript.version = '6.0.4'
      lock.packages['typescript@6.0.4'] = { resolution: { integrity: 'sha512-message-ts2' } }
      lock.snapshots['typescript@6.0.4'] = {}
    }, CLI_IMPORTERS),
    false
  )
})

test('daemon direct dependency bump is a change', () => {
  assert.equal(
    changed((lock) => {
      lock.importers['packages/daemon'].dependencies.zod.version = '4.4.4'
      lock.packages['zod@4.4.4'] = { resolution: { integrity: 'sha512-zod2' } }
      lock.snapshots['zod@4.4.4'] = {}
    }),
    true
  )
})

test('transitive re-resolution under an unchanged direct dep is a change', () => {
  // pnpm dedupe / pnpm up of a shared dep: the importer block stays put but a
  // snapshot dep moves. A whole-importer diff would miss this.
  assert.equal(
    changed((lock) => {
      lock.snapshots['tsdown@0.22.3(typescript@6.0.3)'].dependencies.typescript = '6.0.4'
      lock.packages['typescript@6.0.4'] = { resolution: { integrity: 'sha512-ts2' } }
      lock.snapshots['typescript@6.0.4'] = {}
    }),
    true
  )
})

test('tarball integrity change of a reachable package is a change', () => {
  assert.equal(
    changed((lock) => {
      lock.packages['ws@8.21.0'].resolution.integrity = 'sha512-tampered'
    }),
    true
  )
})

test('global overrides change is a change', () => {
  assert.equal(
    changed((lock) => (lock.overrides = { vite: '8.1.4' })),
    true
  )
})

test('unsupported lockfile version degrades to changed', () => {
  assert.equal(
    changed((lock) => (lock.lockfileVersion = '10.0')),
    true
  )
})

test('missing importer degrades to changed', () => {
  assert.equal(
    changed((lock) => delete lock.importers['packages/protocol']),
    true
  )
})

test('workspace link outside the importer set degrades to changed', () => {
  // A new workspace dep whose dir the caller does not diff — the importer
  // list went stale, so err toward publishing.
  assert.equal(
    changed((lock) => {
      lock.importers['packages/daemon'].dependencies['@agentconnect.md/relay'] = {
        specifier: 'workspace:*',
        version: 'link:../relay'
      }
    }),
    true
  )
})

test('unparseable lockfile degrades to changed', () => {
  assert.equal(lockfileClosureChanged(stringify(baseLock()), '{unbalanced', DAEMON_IMPORTERS), true)
})
