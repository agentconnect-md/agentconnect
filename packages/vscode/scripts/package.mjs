#!/usr/bin/env node
// Builds the extension's VSIX without vsce: `node scripts/package.mjs [version] [output]`; needs the `zip` command.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function packageExtension({ version, output } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // VS Code accepts only a plain major.minor.patch version.
  if (version) manifest.version = version.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Not a major.minor.patch version: ${manifest.version}`)
  const out = resolve(output ?? join(root, `${manifest.name}-${manifest.version}.vsix`))
  const stage = mkdtempSync(join(tmpdir(), 'agentconnect-vsix-'))
  try {
    const extension = join(stage, 'extension')
    mkdirSync(extension)
    cpSync(join(root, 'extension.js'), join(extension, 'extension.js'))
    cpSync(join(root, 'lib'), join(extension, 'lib'), { recursive: true })
    cpSync(join(root, 'README.md'), join(extension, 'readme.md'))
    cpSync(join(root, '..', '..', 'LICENSE'), join(extension, 'LICENSE.txt'))
    writeFileSync(join(extension, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(
      join(stage, '[Content_Types].xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        [
          '.js:application/javascript',
          '.json:application/json',
          '.md:text/markdown',
          '.txt:text/plain',
          '.vsixmanifest:text/xml'
        ]
          .map((entry) => entry.split(':'))
          .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
          .join('') +
        '</Types>\n'
    )
    const property = (id, value) => `<Property Id="Microsoft.VisualStudio.${id}" Value="${escape(value)}" />`
    writeFileSync(
      join(stage, 'extension.vsixmanifest'),
      `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escape(manifest.name)}" Version="${manifest.version}" Publisher="${escape(manifest.publisher)}" />
    <DisplayName>${escape(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${escape(manifest.description)}</Description>
    <Categories>${escape((manifest.categories ?? []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      ${property('Code.Engine', manifest.engines.vscode)}
      ${property('Code.ExtensionDependencies', '')}
      ${property('Code.ExtensionPack', '')}
      ${property('Code.ExtensionKind', 'workspace')}
      ${property('Code.EnabledApiProposals', (manifest.enabledApiProposals ?? []).join(','))}
      ${property('Code.ExecutesCode', 'true')}
      ${property('Services.Links.Source', manifest.repository.url)}
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`
    )
    rmSync(out, { force: true })
    execFileSync('zip', ['-q', '-r', '-X', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], {
      cwd: stage
    })
    return out
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) console.log(packageExtension({ version: process.argv[2], output: process.argv[3] }))
