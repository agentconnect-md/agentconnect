import { CompactToggleField } from '@/components/console/CompactToggleField'

export function RuntimeChatField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <CompactToggleField
      label="Allow change in chat"
      checked={checked}
      onChange={onChange}
      detail={
        checked
          ? 'Chat users can change runtime settings and answer approval requests.'
          : 'Only agent editors can manage runtime settings. Chat users cannot change them or answer approval requests.'
      }
    />
  )
}
