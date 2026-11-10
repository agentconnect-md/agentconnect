// The form-fill extension this daemon ships, compiled in by scripts/bundle.mjs; a source run (tsx, tests) has none.
import type { ExtensionBuild } from './package.js'

declare const __AGENTCONNECT_FORM_FILL_EXTENSION__: ExtensionBuild | undefined

export const FORM_FILL_EXTENSION: ExtensionBuild | undefined =
  typeof __AGENTCONNECT_FORM_FILL_EXTENSION__ === 'object' ? __AGENTCONNECT_FORM_FILL_EXTENSION__ : undefined
