import { readFile } from 'node:fs/promises'
import { ValidationError } from './errors.js'

/**
 * 读取调用方包根目录的版本号。
 *
 * 源码与编译产物都位于包内单层目录（src/lib），因此调用方只需传入
 * `import.meta.url`，无需各适配器重复实现 JSON 读取与类型校验。
 */
export async function readPackageVersion(moduleUrl: string | URL): Promise<string> {
  return readPackageVersionFile(new URL('../package.json', moduleUrl))
}

/** 读取已解析出的 package.json，供同时报告底层 SDK 版本的适配器使用。 */
export async function readPackageVersionFile(packageUrl: string | URL): Promise<string> {
  const resolvedUrl = new URL(packageUrl)
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(resolvedUrl, 'utf8')) as unknown
  } catch (error) {
    throw new ValidationError(`无法读取包元数据: ${resolvedUrl.pathname}`, {
      cause: error instanceof Error ? error : new Error(String(error))
    })
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string' ||
    !metadata.version.trim()
  ) {
    throw new ValidationError(`包元数据缺少有效 version: ${resolvedUrl.pathname}`)
  }
  return metadata.version
}
