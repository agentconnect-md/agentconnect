import { useFormatter } from 'next-intl'

type Formatter = ReturnType<typeof useFormatter>
type DateTimeOptions = Parameters<Formatter['dateTime']>[2]
type NumberOptions = Parameters<Formatter['number']>[2]

export function formatDateTime(formatter: Formatter, value: Date | number, options?: DateTimeOptions) {
  return formatter.dateTime(value, options)
}

export function formatRelative(formatter: Formatter, value: Date | number, now?: Date | number) {
  return formatter.relativeTime(value, now)
}

export function formatNumber(formatter: Formatter, value: number | bigint, options?: NumberOptions) {
  return formatter.number(value, options)
}

export function formatCurrency(formatter: Formatter, value: number | bigint, currency: string) {
  return formatter.number(value, { style: 'currency', currency })
}
