import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [title, ...entries] = process.argv.slice(2)
const summaryDirectory = process.env.VITEST_JOB_SUMMARY_DIR
const outputPath = process.env.GITHUB_STEP_SUMMARY

if (!title || entries.length === 0) {
  throw new Error('usage: merge-vitest-summaries.mjs <title> <file=label> [...]')
}

if (!summaryDirectory || !outputPath) {
  throw new Error('VITEST_JOB_SUMMARY_DIR and GITHUB_STEP_SUMMARY must be set')
}

function normalizeReport(markdown) {
  return markdown
    .replace(/^#{1,2} Vitest Test Report\s*$/m, '')
    .replace(/^#{2,3} Summary\s*$/m, '')
    .replace(/^.*Job summary generated at run-time.*$/m, '')
    .trim()
}

const sections = []

for (const entry of entries) {
  const separator = entry.indexOf('=')
  if (separator <= 0 || separator === entry.length - 1) {
    throw new Error(`invalid report entry: ${entry}`)
  }

  const file = entry.slice(0, separator)
  const label = entry.slice(separator + 1)
  let body

  try {
    body = normalizeReport(await readFile(join(summaryDirectory, `${file}.md`), 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      body = '> No Vitest summary was generated.'
    } else {
      throw error
    }
  }

  sections.push(`## ${label}\n\n${body}`)
}

await appendFile(outputPath, `# ${title}\n\n${sections.join('\n\n')}\n`)
