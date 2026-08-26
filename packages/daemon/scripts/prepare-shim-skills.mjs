import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('skills/package.json'))
const output = new URL('../dist/shim/skills/', import.meta.url)
mkdirSync(output, { recursive: true, mode: 0o755 })
writeFileSync(new URL('package.json', output), '{"name":"skills","version":"1.5.21","type":"module"}\n')
for (const name of ['LICENSE', 'ThirdPartyNoticeText.txt']) {
  copyFileSync(join(packageRoot, name), new URL(name, output))
}
