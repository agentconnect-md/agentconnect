import type { DeploymentFinding } from './check.js'
import type { SetupMode } from './config.js'

export type OutputFormat = 'table' | 'json'

export function parseOutputFormat(value: string): OutputFormat {
  if (value === 'table' || value === 'json') return value
  throw new Error(`unknown format '${value}' (use table or json)`)
}

export function renderReport(
  mode: SetupMode,
  findings: readonly DeploymentFinding[],
  format: OutputFormat,
  checkedAt = new Date().toISOString()
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        schemaVersion: '1',
        mode,
        checkedAt,
        findings,
        summary: {
          pass: findings.filter((finding) => finding.status === 'pass').length,
          fail: findings.filter((finding) => finding.status === 'fail').length
        }
      },
      null,
      2
    )
  }

  return findings
    .map((finding) => `${finding.status === 'pass' ? 'PASS' : 'FAIL'}  ${finding.id.padEnd(22)} ${finding.message}`)
    .join('\n')
}

export function reportExitCode(findings: readonly DeploymentFinding[]): 0 | 1 {
  return findings.some((finding) => finding.status === 'fail') ? 1 : 0
}
