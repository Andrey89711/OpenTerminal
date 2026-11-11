export type Shell = 'powershell' | 'windows-powershell' | 'cmd' | 'wsl';
export type CursorStyle = 'bar' | 'block' | 'underline';
export type Profile = {
  id: string; name: string; shell: Shell; startingDirectory: string; distribution?: string;
  hidden: boolean; noProfile?: boolean; fontFamily?: string; fontSize?: number; colorScheme?: string;
};
export type Tab = { id: string; shell: Shell; profile: Profile };
export const fontFamilies = ['Cascadia Mono', 'Consolas', 'CaskaydiaCove Nerd Font'] as const;
export type ColorScheme = {
  name: string; background: string; foreground: string; cursorColor: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; purple: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightPurple: string; brightCyan: string; brightWhite: string;
};
export type Settings = {
  version: 2; theme: 'dark' | 'light' | 'system'; fontSize: number; fontFamily: string;
  colorScheme: string; cursorStyle: CursorStyle; cursorBlink: boolean; scrollback: number; lineHeight: number;
  copyOnSelect: boolean; copyOnCtrlC: boolean; rightClickPaste: boolean; confirmMultilinePaste: boolean;
  tabWidthMode: 'equal' | 'compact'; useShellTitle: boolean; confirmClose: boolean;
  initialWidth: number; initialHeight: number; launchMode: 'default' | 'maximized';
  defaultProfile: string; profiles: Profile[]; schemes: ColorScheme[];
};
export const terminalFont = (family: string) => `"${family.replace(/["\\\r\n]/g, '')}", "Cascadia Mono", Consolas, monospace`;
export const shellNames: Record<Shell, string> = {
  powershell: 'PowerShell', 'windows-powershell': 'Windows PowerShell', cmd: 'Command Prompt', wsl: 'WSL',
};
