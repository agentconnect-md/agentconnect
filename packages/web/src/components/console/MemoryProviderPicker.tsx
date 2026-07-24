'use client'

import { MEMORY_PROVIDER_OPTIONS, type MemoryProviderChoice } from '@/components/console/memory-settings'

export function MemoryProviderPicker({
  value,
  onChange,
  disabled = false
}: {
  value: MemoryProviderChoice
  onChange: (value: MemoryProviderChoice) => void
  disabled?: boolean
}) {
  const storageOptions = MEMORY_PROVIDER_OPTIONS.filter((option) => !option.separated)
  const offOption = MEMORY_PROVIDER_OPTIONS.find((option) => option.separated)!

  const button = (option: (typeof MEMORY_PROVIDER_OPTIONS)[number]) => (
    <button
      key={option.value}
      type="button"
      disabled={disabled}
      data-memory-provider={option.value}
      className={value === option.value ? 'pill on px-2 py-1 text-[12px]' : 'pill px-2 py-1 text-[12px]'}
      onClick={() => onChange(option.value)}
    >
      {option.label}
    </button>
  )

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Memory backend">
      <div className="pillbar">{storageOptions.map(button)}</div>
      <div className="pillbar">{button(offOption)}</div>
    </div>
  )
}
