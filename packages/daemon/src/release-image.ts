import { readFileSync } from 'node:fs'

export function resolveMicrosandboxImage(image?: string): string {
  if (image !== undefined) return image
  let metadata: unknown
  try {
    // The published bundle and release.json share dist/; source builds have no metadata beside src/.
    metadata = JSON.parse(readFileSync(new URL('./release.json', import.meta.url), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('sandbox.microsandbox.image is required for a build without release image metadata')
    }
    throw new Error('daemon release image metadata could not be read; set sandbox.microsandbox.image explicitly', {
      cause: error
    })
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('runtimeSandboxImage' in metadata) ||
    typeof metadata.runtimeSandboxImage !== 'string' ||
    !metadata.runtimeSandboxImage.trim()
  ) {
    throw new Error('daemon release image metadata is invalid; set sandbox.microsandbox.image explicitly')
  }
  return metadata.runtimeSandboxImage
}
