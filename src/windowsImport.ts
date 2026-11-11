import { getNodeValue, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { BUILTIN_SCHEMES } from './schemes';
import { MAX_PROFILES, normalizeScheme, normalizeSettings } from './settings';
import type { Profile, Settings, Shell } from './types';

export type ImportResult = { settings: Settings; importedProfiles: number; importedSchemes: number; warnings: string[] };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : Object.create(null);
const safeText = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const guid = (value: unknown) => typeof value === 'string' && /^(?:\{[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(value) ? value.replace(/[{}]/g, '').toLowerCase() : undefined;
const distribution = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d][a-z\d._-]{0,127}$/i.test(value);

// Deliberately not a general command-line parser. Only a small, non-executing
// grammar is accepted; imported profiles store shell enums, never commands.
function knownShell(command: unknown): { shell: Shell; distribution?: string; noProfile?: boolean } | null {
  if (!safeText(command, 4096)) return null;
  const tokens = command.match(/"[^"\r\n]*"|[^\s"]+/g);
  if (!tokens || tokens.join(' ').replace(/\s/g, '') !== command.trim().replace(/\s/g, '')) return null;
  const exe = tokens.shift()!.replace(/^"(.*)"$/, '$1').replace(/\//g, '\\').toLowerCase();
  const base = exe.split('\\').pop()!;
  if (!['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe'].includes(base)) return null;
  if (exe !== base) {
    const windows = '(?:[a-z]:\\\\windows|%systemroot%|%windir%)';
    const allowed = base === 'pwsh.exe'
      ? /^(?:[a-z]:\\program files|%programfiles%)\\powershell\\(?:7|7-preview)\\pwsh\.exe$/i.test(exe)
      : new RegExp(`^${windows}\\\\(?:system32|sysnative)\\\\${base === 'powershell.exe' ? 'windowspowershell\\\\v1\\.0\\\\' : ''}${base.replace('.', '\\.')}$`, 'i').test(exe);
    if (!allowed) return null;
  }
  if (base === 'pwsh.exe' || base === 'powershell.exe') {
    if (!tokens.every((arg) => /^-(?:nologo|noprofile)$/i.test(arg))) return null;
    return { shell: base === 'pwsh.exe' ? 'powershell' : 'windows-powershell', noProfile: tokens.some((arg) => /^-noprofile$/i.test(arg)) };
  }
  if (base === 'cmd.exe') return tokens.length === 0 ? { shell: 'cmd' } : null;
  if (!tokens.length) return { shell: 'wsl' };
  const value = tokens[1]?.replace(/^"(.*)"$/, '$1');
  return tokens.length === 2 && /^(?:-d|--distribution)$/.test(tokens[0]) && distribution(value) ? { shell: 'wsl', distribution: value } : null;
}
function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

export function importWindowsTerminal(text: string, current: Settings): ImportResult {
  if (text.length > 2 * 1024 * 1024 || new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('Файл настроек слишком большой (максимум 2 МиБ).');
  const errors: ParseError[] = [];
  let raw: unknown;
  // getNodeValue creates null-prototype objects, unlike parse(), whose plain
  // objects would interpret a JSON __proto__ property as a prototype setter.
  try {
    const tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
    raw = tree ? getNodeValue(tree) : undefined;
  }
  catch { throw new Error('Не удалось разобрать JSONC: слишком сложная структура файла.'); }
  if (errors.length) {
    const error = errors[0];
    const line = text.slice(0, error.offset).split('\n').length;
    throw new Error(`Некорректный JSONC, строка ${line}: ${printParseErrorCode(error.error)}.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Настройки Windows Terminal должны быть JSON-объектом.');
  const root = record(raw);
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const next = normalizeSettings(current);
  const importedIds = new Map<string, string>();
  let importedProfiles = 0;
  let importedSchemes = 0;
  const supportedRoot = new Set(['$schema', 'theme', 'copyOnSelect', 'tabWidthMode', 'confirmCloseAllTabs', 'defaultProfile', 'profiles', 'schemes', 'initialCols', 'initialRows']);
  for (const key of Object.keys(root)) if (!supportedRoot.has(key)) warn(`Параметр ${key} не поддерживается и пропущен.`);
  if ('initialCols' in root || 'initialRows' in root) warn('initialCols/initialRows заданы в символах, а не пикселях; размер окна сохранён без изменений.');
  if (['dark', 'light', 'system'].includes(String(root.theme))) next.theme = root.theme as Settings['theme'];
  else if ('theme' in root) warn('Неподдерживаемая тема пропущена.');
  if (typeof root.copyOnSelect === 'boolean') next.copyOnSelect = root.copyOnSelect;
  if (root.tabWidthMode === 'equal' || root.tabWidthMode === 'compact') next.tabWidthMode = root.tabWidthMode;
  else if ('tabWidthMode' in root) warn('Неподдерживаемый tabWidthMode пропущен.');
  if (typeof root.confirmCloseAllTabs === 'boolean') next.confirmClose = root.confirmCloseAllTabs;
  const schemes = new Map(next.schemes.map((scheme) => [scheme.name, scheme]));
  if (Array.isArray(root.schemes)) for (const item of root.schemes.slice(0, 100)) {
    const candidate = record(item);
    const fallback = BUILTIN_SCHEMES[0];
    const scheme = normalizeScheme({ ...candidate, cursorColor: candidate.cursorColor === undefined ? fallback.cursorColor : candidate.cursorColor, selectionBackground: candidate.selectionBackground === undefined ? fallback.selectionBackground : candidate.selectionBackground });
    if (!scheme) { warn('Некорректная цветовая схема пропущена: нужны имя, foreground/background и все 16 цветов #RRGGBB.'); continue; }
    if (!schemes.has(scheme.name) && schemes.size >= 100) { warn('Достигнут лимит 100 цветовых схем.'); continue; }
    schemes.set(scheme.name, scheme); importedSchemes++;
  }
  next.schemes = [...schemes.values()];
  if (Array.isArray(root.schemes) && root.schemes.length > 100) warn('Обработаны только первые 100 цветовых схем.');
  const chooseScheme = (value: unknown): string | undefined => {
    if (value && typeof value === 'object') { value = record(value).dark; warn('Адаптивная colorScheme: выбран тёмный вариант.'); }
    if (typeof value === 'string' && schemes.has(value)) return value;
    if (value !== undefined) warn('Неизвестная colorScheme пропущена.');
    return undefined;
  };
  const profilesRoot = record(root.profiles);
  const defaults = record(profilesRoot.defaults);
  const defaultFont = record(defaults.font);
  if (safeText(defaultFont.face)) next.fontFamily = defaultFont.face;
  if (typeof defaultFont.size === 'number' && Number.isFinite(defaultFont.size)) next.fontSize = defaultFont.size;
  if (typeof defaultFont.lineHeight === 'number' && Number.isFinite(defaultFont.lineHeight)) next.lineHeight = defaultFont.lineHeight;
  else if ('lineHeight' in defaultFont) warn('font.lineHeight пропущен: требуется числовой множитель.');
  const defaultScheme = chooseScheme(defaults.colorScheme);
  if (defaultScheme) next.colorScheme = defaultScheme;
  const cursors: Record<string, Settings['cursorStyle']> = { bar: 'bar', vintage: 'underline', filledBox: 'block', underscore: 'underline' };
  if (typeof defaults.cursorShape === 'string' && Object.hasOwn(cursors, defaults.cursorShape)) next.cursorStyle = cursors[defaults.cursorShape];
  else if ('cursorShape' in defaults) warn('Неподдерживаемая форма курсора пропущена.');
  if (typeof defaults.historySize === 'number' && Number.isFinite(defaults.historySize)) next.scrollback = defaults.historySize;
  const supportedProfile = new Set(['name', 'guid', 'hidden', 'commandline', 'source', 'startingDirectory', 'font', 'colorScheme']);
  const warnUnsupported = (input: RecordValue, supported: Set<string>, context: string) => {
    for (const key of Object.keys(input)) if (!supported.has(key)) warn(`${context}: ${key} не поддерживается и пропущен.`);
    for (const key of Object.keys(record(input.font))) if (!['face', 'size', 'lineHeight'].includes(key)) warn(`${context}: font.${key} не поддерживается и пропущен.`);
  };
  warnUnsupported(defaults, new Set([...supportedProfile, 'cursorShape', 'historySize']), 'profiles.defaults');
  const list = Array.isArray(root.profiles) ? root.profiles : Array.isArray(profilesRoot.list) ? profilesRoot.list : [];
  for (const item of list) {
    const input = record(item);
    const name = safeText(input.name) ? input.name.trim() : '';
    warnUnsupported(input, supportedProfile, name || 'Профиль');
    if (!name) { warn('Профиль без корректного имени пропущен.'); continue; }
    const source = input.source;
    if (source !== undefined && source !== 'Windows.Terminal.PowershellCore' && source !== 'Windows.Terminal.Wsl') { warn(`Профиль «${name}»: источник не поддерживается, профиль пропущен.`); continue; }
    let shell = knownShell(input.commandline ?? defaults.commandline);
    if (input.commandline === undefined && defaults.commandline === undefined) {
      if (source === 'Windows.Terminal.PowershellCore') shell = { shell: 'powershell' };
      if (source === 'Windows.Terminal.Wsl' && distribution(name)) { shell = { shell: 'wsl', distribution: name }; warn(`Профиль «${name}»: дистрибутив WSL определён по имени; проверьте его наличие.`); }
    }
    if (!shell) { warn(`Профиль «${name}»: неизвестная или небезопасная commandline; профиль пропущен.`); continue; }
    const profileGuid = guid(input.guid);
    const id = `imported-${profileGuid ?? hash(JSON.stringify([name, shell.shell, shell.distribution ?? '']))}`;
    const profile: Profile = { id, name, ...shell, hidden: typeof input.hidden === 'boolean' ? input.hidden : defaults.hidden === true, startingDirectory: safeText(input.startingDirectory, 4096) ? input.startingDirectory : safeText(defaults.startingDirectory, 4096) ? defaults.startingDirectory : '' };
    // The backend's cwd is a Windows host directory, not a Linux guest path.
    // Do not turn '~' or '/home/…' into a different directory behind the user's
    // back. Actual host-directory existence is still checked by the backend.
    if (shell.shell === 'wsl' && profile.startingDirectory && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|%[a-z_][a-z\d_]*%(?:[\\/]|$))/i.test(profile.startingDirectory)) {
      profile.startingDirectory = '';
      warn(`Профиль «${name}»: startingDirectory WSL не является абсолютным каталогом Windows и пропущен (пути Linux и ~ не преобразуются).`);
    }
    const font = { ...defaultFont, ...record(input.font) };
    if (safeText(font.face)) profile.fontFamily = font.face;
    if (typeof font.size === 'number' && Number.isFinite(font.size)) profile.fontSize = font.size;
    if ('lineHeight' in record(input.font)) warn(`Профиль «${name}»: индивидуальный font.lineHeight не поддерживается.`);
    const scheme = chooseScheme(input.colorScheme ?? defaults.colorScheme);
    if (scheme) profile.colorScheme = scheme;
    const index = next.profiles.findIndex((existing) => existing.id === id);
    if (index >= 0) next.profiles[index] = profile;
    else if (next.profiles.length < MAX_PROFILES) next.profiles.push(profile);
    else { warn(`Достигнут лимит ${MAX_PROFILES} профилей; остальные профили пропущены.`); continue; }
    if (profileGuid) importedIds.set(profileGuid, id);
    importedProfiles++;
  }
  if ('defaultProfile' in root) {
    const target = importedIds.get(guid(root.defaultProfile) ?? '');
    if (target && next.profiles.some((profile) => profile.id === target && !profile.hidden)) next.defaultProfile = target;
    else warn('defaultProfile не найден среди импортированных видимых профилей; текущий профиль сохранён.');
  }
  return { settings: normalizeSettings(next), importedProfiles, importedSchemes, warnings };
}
