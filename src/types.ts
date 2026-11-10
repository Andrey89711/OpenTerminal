export type Shell = 'powershell' | 'cmd' | 'wsl';
export type Tab = { id: string; shell: Shell };
export type Settings = { fontSize: number; theme: 'dark' | 'light' };
export const shellNames: Record<Shell, string> = {
  powershell: 'PowerShell', cmd: 'Command Prompt', wsl: 'WSL',
};
