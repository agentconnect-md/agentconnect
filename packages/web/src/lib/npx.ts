// Windows PowerShell reads a bare leading `@` as splatting, so the scoped package is quoted; double quotes read the same in sh and cmd.
export const npxCommand = (spec: string, rest: string): string => `npx -y "${spec}" ${rest}`
