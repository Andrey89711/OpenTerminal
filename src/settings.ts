import { BUILTIN_SCHEMES } from './schemes';
import type { ColorScheme, Profile, Settings, Shell } from './types';

export const STORAGE_KEY = 'openterminal.settings';
export const MAX_PROFILES = 32;
export const COLOR_KEYS = ['background', 'foreground', 'cursorColor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'] as const;
export const DEFAULT_PROFILES: Profile[] = [
  { id: 'powershell', name: 'PowerShell', shell: 'powershell', startingDirectory: '', hidden: false },
  { id: 'windows-powershell', name: 'Windows PowerShell', shell: 'windows-powershell', startingDirectory: '', hidden: false },
  { id: 'cmd', name: 'Command Prompt', shell: 'cmd', startingDirectory: '', hidden: false },
  { id: 'wsl', name: 'WSL', shell: 'wsl', startingDirectory: '', hidden: false },
];

export function defaultSettings(): Settings {
  return {
    version: 2, theme: 'dark', fontSize: 14, fontFamily: 'Cascadia Mono', colorScheme: 'Campbell',
    cursorStyle: 'bar', cursorBlink: true, scrollback: 10000, lineHeight: 1,
    copyOnSelect: false, copyOnCtrlC: true, rightClickPaste: false, confirmMultilinePaste: true,
    tabWidthMode: 'equal', useShellTitle: true, confirmClose: false,
    initialWidth: 1120, initialHeight: 740, launchMode: 'default', defaultProfile: 'powershell',
    profiles: structuredClone(DEFAULT_PROFILES), schemes: structuredClone(BUILTIN_SCHEMES),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const number = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const text = (value: unknown, fallback: string, max = 128) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : fallback;
const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
export const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

export function normalizeScheme(value: unknown): ColorScheme | null {
  const input = record(value);
  if (!text(input.name, '').trim() || !COLOR_KEYS.every((key) => isColor(input[key]))) return null;
  return { name: (input.name as string).trim(), ...Object.fromEntries(COLOR_KEYS.map((key) => [key, input[key]])) } as ColorScheme;
}

export function normalizeSettings(value: unknown): Settings {
  const input = record(value);
  const defaults = defaultSettings();
  const schemes = new Map(defaults.schemes.map((scheme) => [scheme.name, scheme]));
  if (Array.isArray(input.schemes)) {
    for (const raw of input.schemes.slice(0, 100)) {
      const scheme = normalizeScheme(raw);
      if (scheme && (schemes.has(scheme.name) || schemes.size < 100)) schemes.set(scheme.name, scheme);
    }
  }
  const profiles: Profile[] = [];
  if (Array.isArray(input.profiles)) {
    for (const raw of input.profiles.slice(0, MAX_PROFILES)) {
      const p = record(raw);
      const id = text(p.id, '', 128);
      if (!id || profiles.some((profile) => profile.id === id)) continue;
      if (!['powershell', 'windows-powershell', 'cmd', 'wsl'].includes(String(p.shell))) continue;
      const profile: Profile = {
        id, name: text(p.name, 'Профиль').trim() || 'Профиль', shell: p.shell as Shell,
        startingDirectory: text(p.startingDirectory, '', 4096), hidden: bool(p.hidden, false),
      };
      if (profile.shell === 'wsl' && typeof p.distribution === 'string') profile.distribution = text(p.distribution, '', 128);
      if (p.noProfile === true && ['powershell', 'windows-powershell'].includes(profile.shell)) profile.noProfile = true;
      if (typeof p.fontFamily === 'string' && p.fontFamily.trim()) profile.fontFamily = text(p.fontFamily, 'Cascadia Mono');
      if (typeof p.fontSize === 'number') profile.fontSize = number(p.fontSize, 14, 10, 28);
      if (typeof p.colorScheme === 'string' && schemes.has(p.colorScheme)) profile.colorScheme = p.colorScheme;
      profiles.push(profile);
    }
  }
  const safeProfiles = profiles.length ? profiles : defaults.profiles;
  if (safeProfiles.every((profile) => profile.hidden)) safeProfiles[0].hidden = false;
  const defaultProfile = safeProfiles.some((profile) => profile.id === input.defaultProfile && !profile.hidden)
    ? input.defaultProfile as string : safeProfiles.find((profile) => !profile.hidden)!.id;
  return {
    version: 2,
    theme: ['dark', 'light', 'system'].includes(String(input.theme)) ? input.theme as Settings['theme'] : defaults.theme,
    fontSize: number(input.fontSize, defaults.fontSize, 10, 28), fontFamily: text(input.fontFamily, defaults.fontFamily).trim() || defaults.fontFamily,
    colorScheme: typeof input.colorScheme === 'string' && schemes.has(input.colorScheme) ? input.colorScheme : defaults.colorScheme,
    cursorStyle: ['bar', 'block', 'underline'].includes(String(input.cursorStyle)) ? input.cursorStyle as Settings['cursorStyle'] : defaults.cursorStyle,
    cursorBlink: bool(input.cursorBlink, defaults.cursorBlink), scrollback: Math.round(number(input.scrollback, defaults.scrollback, 0, 100000)),
    lineHeight: number(input.lineHeight, defaults.lineHeight, 1, 2),
    copyOnSelect: bool(input.copyOnSelect, defaults.copyOnSelect), copyOnCtrlC: bool(input.copyOnCtrlC, defaults.copyOnCtrlC),
    rightClickPaste: bool(input.rightClickPaste, defaults.rightClickPaste), confirmMultilinePaste: bool(input.confirmMultilinePaste, defaults.confirmMultilinePaste),
    tabWidthMode: input.tabWidthMode === 'compact' ? 'compact' : 'equal', useShellTitle: bool(input.useShellTitle, defaults.useShellTitle),
    confirmClose: bool(input.confirmClose, defaults.confirmClose),
    initialWidth: Math.round(number(input.initialWidth, defaults.initialWidth, 600, 3840)),
    initialHeight: Math.round(number(input.initialHeight, defaults.initialHeight, 400, 2160)),
    launchMode: input.launchMode === 'maximized' ? 'maximized' : 'default',
    defaultProfile, profiles: safeProfiles, schemes: [...schemes.values()],
  };
}

export function loadSettings(): Settings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); }
  catch { return defaultSettings(); }
}

export function resolveTerminalSettings(settings: Settings, profile: Profile): Settings {
  const current = settings.profiles.find((candidate) => candidate.id === profile.id) ?? profile;
  return { ...settings, fontSize: current.fontSize ?? settings.fontSize, fontFamily: current.fontFamily ?? settings.fontFamily, colorScheme: current.colorScheme ?? settings.colorScheme };
}

export function parseSettingsJson(text: string): Settings {
  if (text.length > 2 * 1024 * 1024) throw new Error('Файл настроек слишком большой (максимум 2 МиБ).');
  const input = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Настройки должны быть JSON-объектом.');
  return normalizeSettings(input);
}
