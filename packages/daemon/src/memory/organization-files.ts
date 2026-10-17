// The organization files' shapes live in the protocol package so the Control Plane checks console edits the same way (assistant-mode.md §5.16).
export {
  CHANNELS_FILE,
  MEMBER_ENTRY_LINES,
  MEMBER_FIELDS,
  MEMBERS_FILE,
  ORGANIZATION_FILE,
  ORGANIZATION_FILES,
  ORGANIZATION_MAX_BYTES,
  ORGANIZATION_SECTIONS,
  ORGANIZATION_SUMMARY_LINES,
  organizationFileOf,
  organizationFileRefusal,
  parseOrganizationFile,
  type FactLine,
  type FactSource,
  type MemberEntry,
  type MemberField,
  type MemoryTextCheck,
  type OrganizationFile,
  type OrganizationFileParse,
  type ParsedOrganizationFile
} from '@agentconnect.md/protocol'
