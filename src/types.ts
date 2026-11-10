export type Shell = 'powershell' | 'cmd' | 'wsl';
export type Tab = { id: string; shell: Shell };
export const fontFamilies = ['Cascadia Mono', 'Consolas', 'CaskaydiaCove Nerd Font'] as const;
export type Settings = { fontSize: number; fontFamily: typeof fontFamilies[number]; theme: 'dark' | 'light'; promptPath: string };
export const terminalFont = (family: Settings['fontFamily']) => `"${family}", "Cascadia Mono", Consolas, monospace`;
export const shellNames: Record<Shell, string> = {
  powershell: 'PowerShell', cmd: 'Command Prompt', wsl: 'WSL',
};
