import { expect, test } from '@playwright/test';
import { BUILTIN_SCHEMES, schemeToXterm } from '../src/schemes';
import { defaultSettings, normalizeSettings } from '../src/settings';
import { importWindowsTerminal } from '../src/windowsImport';

const psGuid = '11111111-2222-3333-4444-555555555555';
const wt = (value: unknown, current = defaultSettings()) => importWindowsTerminal(JSON.stringify(value), current);
const imported = (value: unknown) => wt({ profiles: { list: [value] } });

test('canonical Windows Terminal schemes and xterm mapping', () => {
  expect(BUILTIN_SCHEMES.map((scheme) => scheme.name)).toEqual(['Campbell', 'Campbell Powershell', 'Vintage', 'One Half Dark', 'One Half Light', 'Solarized Dark', 'Solarized Light', 'Tango Dark', 'Tango Light']);
  const campbell = BUILTIN_SCHEMES[0];
  expect(campbell).toMatchObject({ background: '#0C0C0C', blue: '#0037DA', brightPurple: '#B4009E' });
  expect(BUILTIN_SCHEMES[1].background).toBe('#012456');
  expect(BUILTIN_SCHEMES[4]).toMatchObject({ cursorColor: '#4F525D', selectionBackground: '#383A42', brightRed: '#DF6C75' });
  expect(schemeToXterm(campbell)).toMatchObject({ magenta: campbell.purple, brightMagenta: campbell.brightPurple, cursor: campbell.cursorColor });
  expect(schemeToXterm(campbell)).not.toHaveProperty('purple');
  expect(normalizeSettings({ schemes: BUILTIN_SCHEMES }).schemes).toHaveLength(9);
});

test('JSONC comments, BOM, trailing commas and essential root values', () => {
  const current = defaultSettings();
  const result = importWindowsTerminal('\uFEFF{ // comment\n "theme":"system", "copyOnSelect":true, "tabWidthMode":"compact", "confirmCloseAllTabs":true, "initialCols":180,"initialRows":60,}', current);
  expect(result.settings).toMatchObject({ theme: 'system', copyOnSelect: true, tabWidthMode: 'compact', confirmClose: true, initialWidth: current.initialWidth, initialHeight: current.initialHeight });
  expect(result.warnings.join(' ')).toContain('не пикселях');
});

test('reject malformed JSONC, non-object roots and oversized UTF-8', () => {
  for (const text of ['null', '[]', '42', 'true', '"object"']) expect(() => importWindowsTerminal(text, defaultSettings())).toThrow('JSON-объектом');
  for (const text of ['', '{"theme":', '{ bad }', '{} {}']) expect(() => importWindowsTerminal(text, defaultSettings())).toThrow(/JSONC|JSON-объектом/);
  expect(() => importWindowsTerminal(`{"x":"${'я'.repeat(1024 * 1024)}"}`, defaultSettings())).toThrow('2 МиБ');
});

test('prototype properties cannot supply settings or executable fields', () => {
  const result = importWindowsTerminal('{"__proto__":{"theme":"light","copyOnSelect":true},"profiles":{"list":[{"name":"evil","__proto__":{"commandline":"pwsh.exe"}}]}}', defaultSettings());
  expect(result.settings.theme).toBe('dark');
  expect(result.settings.copyOnSelect).toBe(false);
  expect(result.importedProfiles).toBe(0);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test('unsafe command lines are skipped, never converted to PowerShell', () => {
  for (const commandline of ['evil.exe', 'C:\\custom\\pwsh.exe', 'pwsh.exe -Command calc', 'pwsh.exe -EncodedCommand YQ==', 'pwsh.exe -File startup.ps1', 'powershell.exe & calc.exe', 'cmd.exe /k calc', 'cmd.exe /c calc', 'wsl.exe --exec sh', 'wsl.exe -d Ubuntu -- bash', 'pwsh.exe "-NoProfile', 'pwsh.exe;calc']) {
    const result = imported({ name: 'Unsafe', commandline });
    expect(result.importedProfiles, commandline).toBe(0);
    expect(result.settings.profiles).toEqual(defaultSettings().profiles);
    expect(result.warnings.join(' ')).toContain('пропущен');
  }
});

test('distinguishes Windows PowerShell and pwsh, accepts only common paths', () => {
  for (const commandline of ['pwsh.exe', 'pwsh.exe -NoLogo -NoProfile', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', '"%ProgramFiles%\\PowerShell\\7\\pwsh.exe" -NoProfile']) {
    const result = imported({ name: 'PS7', commandline });
    expect(result.settings.profiles.at(-1)?.shell, commandline).toBe('powershell');
    expect(result.importedProfiles, commandline).toBe(1);
  }
  for (const commandline of ['powershell.exe', '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo']) {
    expect(imported({ name: 'WinPS', commandline }).settings.profiles.at(-1)?.shell, commandline).toBe('windows-powershell');
  }
  expect(imported({ name: 'CMD', commandline: '%SystemRoot%\\System32\\cmd.exe' }).settings.profiles.at(-1)?.shell).toBe('cmd');
  expect(imported({ name: 'Clean PS', commandline: 'pwsh.exe -NoProfile' }).settings.profiles.at(-1)?.noProfile).toBe(true);
  const normalized = normalizeSettings({ profiles: [{ id: 'changed', name: 'CMD', shell: 'cmd', hidden: false, startingDirectory: '', distribution: 'Ubuntu', noProfile: true }] });
  expect(normalized.profiles[0]).not.toHaveProperty('distribution');
  expect(normalized.profiles[0]).not.toHaveProperty('noProfile');
});

test('WSL distributions and supported dynamic sources', () => {
  for (const commandline of ['wsl.exe -d Ubuntu-24.04', '%SystemRoot%\\System32\\wsl.exe --distribution "Ubuntu-24.04"']) {
    expect(imported({ name: 'Linux', commandline }).settings.profiles.at(-1)).toMatchObject({ shell: 'wsl', distribution: 'Ubuntu-24.04' });
  }
  const dynamic = imported({ name: 'Ubuntu', source: 'Windows.Terminal.Wsl' });
  expect(dynamic.settings.profiles.at(-1)).toMatchObject({ shell: 'wsl', distribution: 'Ubuntu' });
  expect(dynamic.warnings.join(' ')).toContain('по имени');
  expect(imported({ name: 'PowerShell', source: 'Windows.Terminal.PowershellCore' }).importedProfiles).toBe(1);
  for (const profile of [{ name: 'Linux (default)', source: 'Windows.Terminal.Wsl' }, { name: 'Azure', source: 'Windows.Terminal.Azure' }, { name: 'Dev', source: 'Windows.Terminal.VisualStudio', commandline: 'cmd.exe' }, { name: 'Linux', commandline: 'wsl.exe -d --help' }]) expect(imported(profile).importedProfiles).toBe(0);
});

test('profile defaults, font, cursor, default GUID and hidden mapping', () => {
  const result = wt({ defaultProfile: `{${psGuid.toUpperCase()}}`, profiles: {
    defaults: { font: { face: 'Consolas', size: 18, lineHeight: 1.3 }, startingDirectory: '%USERPROFILE%', colorScheme: { dark: 'Tango Dark', light: 'Tango Light' }, cursorShape: 'filledBox', historySize: 1234 },
    list: [{ name: 'Mine', guid: `{${psGuid}}`, commandline: 'pwsh.exe' }, { name: 'Hidden', guid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', commandline: 'cmd.exe', hidden: true, font: { size: 16 } }],
  } });
  expect(result.settings).toMatchObject({ fontFamily: 'Consolas', fontSize: 18, lineHeight: 1.3, scrollback: 1234, cursorStyle: 'block', colorScheme: 'Tango Dark', defaultProfile: `imported-${psGuid}` });
  expect(result.settings.profiles.at(-2)).toMatchObject({ startingDirectory: '%USERPROFILE%', fontFamily: 'Consolas', fontSize: 18, colorScheme: 'Tango Dark' });
  expect(result.settings.profiles.at(-1)).toMatchObject({ hidden: true, fontSize: 16 });
  expect(result.warnings.join(' ')).toContain('тёмный');
  for (const [shape, mapped] of [['bar', 'bar'], ['vintage', 'underline'], ['underscore', 'underline']]) expect(wt({ profiles: { defaults: { cursorShape: shape } } }).settings.cursorStyle).toBe(mapped);
});

test('WSL Linux directories are skipped with warning; supported host defaults are inherited', () => {
  for (const startingDirectory of ['~', '~/projects', '/home/me', '/tmp', 'relative/linux/path']) {
    const result = wt({ profiles: { defaults: { startingDirectory }, list: [{ name: 'Ubuntu', source: 'Windows.Terminal.Wsl' }] } });
    expect(result.settings.profiles.at(-1)?.startingDirectory).toBe('');
    expect(result.warnings.join(' ')).toContain('пути Linux и ~ не преобразуются');
  }
  for (const startingDirectory of ['C:\\Users\\me', '%USERPROFILE%', '\\\\localhost\\share']) {
    const result = wt({ profiles: { defaults: { startingDirectory }, list: [{ name: 'Ubuntu', source: 'Windows.Terminal.Wsl' }] } });
    expect(result.settings.profiles.at(-1)?.startingDirectory).toBe(startingDirectory);
  }
  const override = wt({ profiles: { defaults: { startingDirectory: 'C:\\Users\\me' }, list: [{ name: 'Ubuntu', source: 'Windows.Terminal.Wsl', startingDirectory: '/home/me' }] } });
  expect(override.settings.profiles.at(-1)?.startingDirectory).toBe('');
});

test('custom schemes require all palette colors; optional cursor/selection use Campbell', () => {
  const { cursorColor: _cursor, selectionBackground: _selection, ...palette } = BUILTIN_SCHEMES[3];
  const result = wt({ schemes: [{ ...palette, name: 'My custom' }, { name: 'Incomplete', background: '#000000' }], profiles: { defaults: { colorScheme: 'My custom' } } });
  expect(result.importedSchemes).toBe(1);
  expect(result.settings.schemes.find((scheme) => scheme.name === 'My custom')).toMatchObject({ cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', red: '#E06C75' });
  expect(result.settings.colorScheme).toBe('My custom');
  expect(result.warnings.join(' ')).toContain('16 цветов');
  expect(wt({ schemes: [{ ...BUILTIN_SCHEMES[0], name: 'Bad color', red: 'javascript:alert(1)' }] }).importedSchemes).toBe(0);
});

test('normalizes numeric bounds and preserves existing unrelated preferences', () => {
  const current = defaultSettings();
  current.copyOnCtrlC = false;
  current.rightClickPaste = true;
  current.initialWidth = 1300;
  const result = wt({ profiles: { defaults: { font: { size: 999, lineHeight: 999 }, historySize: -100 }, list: [{ name: 'CMD', commandline: 'cmd.exe', font: { size: -42 } }] } }, current);
  expect(result.settings).toMatchObject({ fontSize: 28, lineHeight: 2, scrollback: 0, copyOnCtrlC: false, rightClickPaste: true, initialWidth: 1300 });
  expect(result.settings.profiles.at(-1)?.fontSize).toBe(10);
  expect(current).toEqual({ ...defaultSettings(), copyOnCtrlC: false, rightClickPaste: true, initialWidth: 1300 });
});

test('merges profiles without destroying old entries; reimport is idempotent', () => {
  const input = { profiles: { list: [{ name: 'PS', guid: psGuid, commandline: 'pwsh.exe' }, { name: 'Linux', commandline: 'wsl.exe -d Debian' }] } };
  const first = wt(input);
  expect(first.settings.profiles.slice(0, 4)).toEqual(defaultSettings().profiles);
  const second = wt(input, first.settings);
  expect(second.settings).toEqual(first.settings);
  expect(first.settings.profiles.at(-1)?.id).toMatch(/^imported-[a-f\d]{8}$/);
  expect(JSON.stringify(first.settings.profiles)).not.toContain('commandline');
});

test('bounded profile merging preserves all 32 existing profiles', () => {
  const current = defaultSettings();
  current.profiles = Array.from({ length: 32 }, (_, i) => ({ ...current.profiles[0], id: `old-${i}`, name: `Old ${i}` }));
  current.defaultProfile = 'old-0';
  const result = wt({ profiles: { list: [{ name: 'New', commandline: 'cmd.exe' }] } }, current);
  expect(result.importedProfiles).toBe(0);
  expect(result.settings.profiles).toEqual(current.profiles);
  expect(result.warnings.join(' ')).toContain('32');
});

test('warns for unsupported features and does not retain OpenPrompt or arbitrary fields', () => {
  const result = wt({ actions: [], keybindings: [], extensions: {}, openPrompt: { enabled: true }, profiles: { defaults: { backgroundImage: 'evil.png', useAcrylic: true, font: { weight: 'bold' } }, list: [{ name: 'CMD', commandline: 'cmd.exe', icon: 'evil.ico' }] } });
  for (const key of ['actions', 'keybindings', 'extensions', 'openPrompt', 'backgroundImage', 'useAcrylic', 'font.weight', 'icon']) expect(result.warnings.join(' ')).toContain(key);
  expect(JSON.stringify(result.settings).toLowerCase()).not.toContain('openprompt');
  expect(JSON.stringify(result.settings)).not.toContain('evil');
});

test('invalid or hidden imported default profile does not replace user default', () => {
  for (const defaultProfile of ['bogus', `{${psGuid}}`]) {
    const result = wt({ defaultProfile, profiles: { list: [{ name: 'Hidden', guid: psGuid, commandline: 'cmd.exe', hidden: true }] } });
    expect(result.settings.defaultProfile).toBe('powershell');
    expect(result.warnings.join(' ')).toContain('defaultProfile');
  }
});
