import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronRight, Code2, Download, Info, Keyboard, Menu, Monitor, Palette, Play, Plus, Settings2, TerminalSquare } from 'lucide-react';
import license from '../LICENSE?raw';
import thirdPartyNotices from '../THIRD_PARTY_NOTICES.md?raw';
import { version } from '../package.json';
import { COLOR_KEYS, MAX_PROFILES, normalizeSettings, parseSettingsJson } from './settings';
import { importWindowsTerminal } from './windowsImport';
import { schemeToXterm } from './schemes';
import { fontFamilies, shellNames, terminalFont, type ColorScheme, type Profile, type Settings, type Shell } from './types';
import '@xterm/xterm/css/xterm.css';
import './settings.css';

type Section = 'launch' | 'interaction' | 'appearance' | 'schemes' | 'actions' | 'import' | 'about' | 'defaults' | 'add' | 'json' | `profile:${string}`;
type ImportPreview = ReturnType<typeof importWindowsTerminal>;
const colorLabels: Record<(typeof COLOR_KEYS)[number], string> = {
  background: 'Фон', foreground: 'Текст', cursorColor: 'Курсор', selectionBackground: 'Выделение',
  black: 'Чёрный', red: 'Красный', green: 'Зелёный', yellow: 'Жёлтый', blue: 'Синий', purple: 'Пурпурный', cyan: 'Голубой', white: 'Белый',
  brightBlack: 'Яркий чёрный', brightRed: 'Яркий красный', brightGreen: 'Яркий зелёный', brightYellow: 'Яркий жёлтый', brightBlue: 'Яркий синий', brightPurple: 'Яркий пурпурный', brightCyan: 'Яркий голубой', brightWhite: 'Яркий белый',
};
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Не удалось выполнить действие. Попробуйте выбрать файл вручную.';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string }>, { id, 'aria-labelledby': `${id}-label`, 'aria-describedby': hint ? `${id}-hint` : undefined }) : children;
  return <label className="settings-workspace-field" htmlFor={id}><span><span id={`${id}-label`}>{label}</span>{hint && <small id={`${id}-hint`}>{hint}</small>}</span>{control}</label>;
}

function SchemePreview({ scheme, settings }: { scheme: ColorScheme; settings: Settings }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const terminal = new Xterm({ disableStdin: true, cursorBlink: false, cursorStyle: settings.cursorStyle, fontFamily: terminalFont(settings.fontFamily), fontSize: settings.fontSize, lineHeight: settings.lineHeight, scrollback: 0, theme: schemeToXterm(scheme), allowProposedApi: false });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const resize = () => { try { fit.fit(); } catch { /* Pane may be hidden during layout. */ } };
    resize();
    terminal.write('Windows PowerShell\r\n\r\n\x1b[32mPS\x1b[0m C:\\Users\\User> \x1b[33mGet-ChildItem\x1b[0m\r\n\r\n');
    terminal.write('    \x1b[34mDirectory\x1b[0m: C:\\Users\\User\r\n\r\n');
    terminal.write('\x1b[36mDocuments\x1b[0m   \x1b[35mProjects\x1b[0m   README.md\r\n');
    terminal.write('\x1b[31mError\x1b[0m  \x1b[33mWarning\x1b[0m  \x1b[32mSuccess\x1b[0m\r\n\r\nPS C:\\Users\\User> ');
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => { observer.disconnect(); terminal.dispose(); };
  }, [scheme, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.cursorStyle]);
  return <div className="settings-workspace-preview" ref={host} role="img" aria-label="Предпросмотр цветов терминала, только для чтения" />;
}

export function SettingsPage({ settings, onSave, onCancel }: { settings: Settings; onSave: (next: Settings) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings));
  const [section, setSection] = useState<Section>('launch');
  const [sidebar, setSidebar] = useState(true);
  const [schemeName, setSchemeName] = useState(settings.colorScheme);
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [newShell, setNewShell] = useState<Shell>('powershell');
  const [duplicate, setDuplicate] = useState('');
  const alive = useRef(false);
  const operation = useRef(0);
  const fontList = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft(current => ({ ...current, [key]: value }));
  const profile = section.startsWith('profile:') ? draft.profiles.find(p => p.id === section.slice(8)) : undefined;
  const scheme = draft.schemes.find(s => s.name === schemeName) ?? draft.schemes[0];
  const updateProfile = (patch: Partial<Profile>) => { if (profile) update('profiles', draft.profiles.map(p => p.id === profile.id ? { ...p, ...patch } : p)); };

  async function listSources() {
    const token = ++operation.current;
    setBusy(true);
    try {
      const result = await invoke<unknown>('list_windows_terminal_settings');
      if (!alive.current || token !== operation.current) return;
      const valid = Array.isArray(result) ? result.filter((item): item is { id: string; label: string } => !!item && typeof item.id === 'string' && typeof item.label === 'string') : [];
      setSources(valid); setSource(valid[0]?.id ?? '');
      if (!valid.length) setNotice('Настройки Windows Terminal не найдены. Выберите файл JSONC вручную.');
    } catch (e) { if (alive.current && token === operation.current) setError(message(e)); }
    finally { if (alive.current && token === operation.current) setBusy(false); }
  }

  function navigate(next: Section) {
    setSection(next); setError(''); setNotice('');
    if (next === 'json') setJson(JSON.stringify(draft, null, 2));
    if (next === 'import' && section !== 'import') void listSources();
  }

  async function readSource() {
    const token = ++operation.current;
    const current = structuredClone(draft);
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const text = await invoke<unknown>('read_windows_terminal_settings', { id: source });
      if (!alive.current || token !== operation.current) return;
      if (typeof text !== 'string') throw new Error('Источник не вернул текст настроек. Выберите файл JSONC вручную.');
      setPreview(importWindowsTerminal(text, current));
    } catch (e) { if (alive.current && token === operation.current) setError(message(e)); }
    finally { if (alive.current && token === operation.current) setBusy(false); }
  }

  async function readFile(file: File | undefined, windows: boolean) {
    if (!file) return;
    const token = ++operation.current;
    const current = structuredClone(draft);
    setBusy(true); setError(''); setNotice('');
    if (windows) setPreview(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 2 МиБ).');
      const text = await file.text();
      if (!alive.current || token !== operation.current) return;
      if (windows) setPreview(importWindowsTerminal(text, current));
      else { setJson(text); setNotice('Файл прочитан. Нажмите «Применить JSON», чтобы обновить черновик.'); }
    } catch (e) { if (alive.current && token === operation.current) setError(message(e)); }
    finally { if (alive.current && token === operation.current) setBusy(false); }
  }

  function addProfile() {
    if (draft.profiles.length >= MAX_PROFILES) return;
    const original = draft.profiles.find(p => p.id === duplicate);
    const added: Profile = original ? { ...original, id: crypto.randomUUID(), name: `${original.name} (копия)`, hidden: false } : { id: crypto.randomUUID(), name: shellNames[newShell], shell: newShell, startingDirectory: '', hidden: false };
    update('profiles', [...draft.profiles, added]); navigate(`profile:${added.id}`);
  }

  const selectSchemes = (value: string, change: (value: string) => void, inherit = false) => <select value={value} onChange={e => change(e.target.value)}>{inherit && <option value="">По умолчанию ({draft.colorScheme})</option>}{draft.schemes.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select>;
  const toggle = (key: keyof Settings, label: string, hint?: string) => <Field label={label} hint={hint}><input type="checkbox" role="switch" checked={Boolean(draft[key])} onChange={e => update(key, e.target.checked)} /></Field>;
  const navItems = [
    ['launch', 'Запуск', Play], ['interaction', 'Взаимодействие', Settings2], ['appearance', 'Оформление', Monitor],
    ['schemes', 'Цветовые схемы', Palette], ['actions', 'Действия', Keyboard], ['import', 'Импорт настроек', Download],
    ['about', 'О программе', Info],
  ] as const;
  const title = profile?.name ?? ({ launch: 'Запуск', interaction: 'Взаимодействие', appearance: 'Оформление', schemes: 'Цветовые схемы', actions: 'Действия', import: 'Импорт настроек', about: 'О программе', defaults: 'По умолчанию', add: 'Добавить новый профиль', json: 'Редактировать JSON' } as Record<string, string>)[section] ?? 'Профиль';

  return <section className={`settings-workspace ${sidebar ? '' : 'settings-workspace-collapsed'}`} aria-label="Параметры OpenTerminal">
    <div className="settings-workspace-toolbar"><button type="button" onClick={() => setSidebar(value => !value)} aria-label={sidebar ? 'Скрыть разделы' : 'Показать разделы'} aria-expanded={sidebar} aria-controls="settings-navigation"><Menu size={18} /></button></div>
    <div className="settings-workspace-body">
      {sidebar && <nav id="settings-navigation" className="settings-workspace-sidebar" aria-label="Разделы настроек">
        <h2>Параметры</h2>
        {navItems.map(([id, label, Icon]) => <button type="button" key={id} className={section === id ? 'is-active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span></button>)}
        <h3>Профили</h3>
        <button type="button" className={section === 'defaults' ? 'is-active' : ''} aria-current={section === 'defaults' ? 'page' : undefined} onClick={() => navigate('defaults')}><Settings2 size={18} /><span>По умолчанию</span></button>
        {draft.profiles.map(p => <button type="button" key={p.id} className={profile?.id === p.id ? 'is-active' : ''} aria-current={profile?.id === p.id ? 'page' : undefined} onClick={() => navigate(`profile:${p.id}`)}><TerminalSquare size={18} /><span>{p.name}{p.hidden && <small>Скрыт</small>}</span></button>)}
        <button type="button" className={section === 'add' ? 'is-active' : ''} onClick={() => navigate('add')}><Plus size={18} /><span>Добавить новый профиль</span></button>
      </nav>}
      <section className="settings-workspace-content" key={section} aria-label={title}>
        <div className="settings-workspace-heading"><div className="settings-workspace-breadcrumb">Параметры {(profile || section === 'defaults') && <><ChevronRight size={13} />Профили</>}</div><h1>{title}</h1><p>Изменения применяются только после нажатия «Сохранить».</p></div>
        {error && <div className="settings-workspace-error" role="alert">{error}</div>}
        {notice && <div className="settings-workspace-notice" role="status">{notice}</div>}
        <datalist id={fontList}>{[...fontFamilies, 'Cascadia Code', 'Courier New', 'Lucida Console'].map(font => <option key={font} value={font} />)}</datalist>

        {section === 'launch' && <>
          <Field label="Профиль по умолчанию"><select value={draft.defaultProfile} onChange={e => update('defaultProfile', e.target.value)}>{draft.profiles.filter(p => !p.hidden).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <h2>Размер окна при запуске</h2>
          <Field label="Начальная ширина" hint="Логические пиксели, от 600 до 3840"><input type="number" min={600} max={3840} step={1} value={draft.initialWidth} onChange={e => update('initialWidth', Number(e.target.value))} /></Field>
          <Field label="Начальная высота" hint="Логические пиксели, от 400 до 2160"><input type="number" min={400} max={2160} step={1} value={draft.initialHeight} onChange={e => update('initialHeight', Number(e.target.value))} /></Field>
          <Field label="Режим запуска"><select value={draft.launchMode} onChange={e => update('launchMode', e.target.value as Settings['launchMode'])}><option value="default">Обычное окно</option><option value="maximized">Развёрнутое окно</option></select></Field>
          <p className="settings-workspace-note">Размер и режим окна используются при следующем запуске приложения.</p>
        </>}
        {section === 'interaction' && <>
          {toggle('copyOnSelect', 'Копировать при выделении')}
          {toggle('copyOnCtrlC', 'Копировать выделение по Ctrl+C', 'Без выделения Ctrl+C передаётся оболочке.')}
          {toggle('rightClickPaste', 'Вставлять правой кнопкой мыши')}
          {toggle('confirmMultilinePaste', 'Подтверждать многострочную вставку')}
          {toggle('confirmClose', 'Подтверждать закрытие окна с сессиями')}
        </>}
        {section === 'appearance' && <>
          <Field label="Тема приложения"><select value={draft.theme} onChange={e => update('theme', e.target.value as Settings['theme'])}><option value="dark">Тёмная</option><option value="light">Светлая</option><option value="system">Как в системе</option></select></Field>
          <Field label="Ширина вкладок"><select value={draft.tabWidthMode} onChange={e => update('tabWidthMode', e.target.value as Settings['tabWidthMode'])}><option value="equal">Одинаковая</option><option value="compact">Компактная</option></select></Field>
          {toggle('useShellTitle', 'Использовать заголовок оболочки')}
          <button type="button" className="settings-workspace-link" onClick={() => navigate('defaults')}>Шрифт, курсор и цвета профилей <ChevronRight size={16} /></button>
        </>}
        {section === 'defaults' && <>
          <p className="settings-workspace-note">Общие параметры терминала. Отдельные профили могут переопределять шрифт, его размер и цветовую схему.</p>
          <Field label="Гарнитура шрифта" hint="Шрифт должен быть установлен в системе."><input list={fontList} value={draft.fontFamily} onChange={e => update('fontFamily', e.target.value)} /></Field>
          <Field label="Размер шрифта"><input type="number" min={10} max={28} value={draft.fontSize} onChange={e => update('fontSize', Number(e.target.value))} /></Field>
          <Field label="Форма курсора"><select value={draft.cursorStyle} onChange={e => update('cursorStyle', e.target.value as Settings['cursorStyle'])}><option value="bar">Вертикальная черта</option><option value="block">Блок</option><option value="underline">Подчёркивание</option></select></Field>
          {toggle('cursorBlink', 'Мигание курсора')}
          <Field label="Размер истории" hint="Количество строк, от 0 до 100 000"><input type="number" min={0} max={100000} step={1} value={draft.scrollback} onChange={e => update('scrollback', Number(e.target.value))} /></Field>
          <Field label="Межстрочный интервал"><input type="number" min={1} max={2} step={0.05} value={draft.lineHeight} onChange={e => update('lineHeight', Number(e.target.value))} /></Field>
          <Field label="Цветовая схема">{selectSchemes(draft.colorScheme, value => update('colorScheme', value))}</Field>
        </>}
        {section === 'schemes' && scheme && <>
          <p className="settings-workspace-note">Выберите схему для редактирования. Схема терминала выбирается в разделе «По умолчанию» или в профиле.</p>
          <div className="settings-workspace-schemes" aria-label="Цветовые схемы">{draft.schemes.map(s => <button type="button" key={s.name} aria-pressed={scheme.name === s.name} onClick={() => setSchemeName(s.name)}><span>{s.name}</span><span className="settings-workspace-swatches" aria-hidden="true">{['background', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'foreground'].map(key => <i key={key} style={{ backgroundColor: s[key as keyof ColorScheme] }} />)}</span></button>)}</div>
          <h2>Предпросмотр — {scheme.name}</h2><SchemePreview scheme={scheme} settings={draft} />
          <h2>Цвета схемы</h2><div className="settings-workspace-colors">{COLOR_KEYS.map(key => <label key={key}><span>{colorLabels[key]}</span><input type="color" value={scheme[key]} onChange={e => update('schemes', draft.schemes.map(s => s.name === scheme.name ? { ...s, [key]: e.target.value } : s))} /><code>{scheme[key]}</code></label>)}</div>
        </>}
        {section === 'actions' && <>
          <p className="settings-workspace-note">Существующие сочетания клавиш. Изменение назначений пока не поддерживается.</p>
          <dl className="settings-workspace-shortcuts">{[
            ['Новая вкладка', 'Ctrl + Shift + T'], ['Закрыть вкладку', 'Ctrl + Shift + W'], ['Открыть параметры', 'Ctrl + ,'], ['Размер шрифта', 'Ctrl + колесо'], ['Копировать выделение', 'Ctrl + C'], ['Копировать', 'Ctrl + Shift + C'], ['Вставить', 'Ctrl + Shift + V'], ['Прервать команду (без выделения)', 'Ctrl + C'],
          ].map(([label, keys]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
        </>}
        {section === 'about' && <>
          <h2>OpenTerminal {version}</h2>
          <p>Самостоятельный терминал на Tauri, Rust и xterm.js. Не является продуктом Microsoft и не включает движки оформления приглашения.</p>
          <details><summary>Лицензия OpenTerminal — MIT</summary><pre className="settings-workspace-license">{license}</pre></details>
          <details><summary>Лицензии цветовых схем Windows Terminal и JSONC-парсера</summary><pre className="settings-workspace-license">{thirdPartyNotices}</pre></details>
        </>}
        {section === 'add' && <>
          <p className="settings-workspace-note">Создайте профиль известной оболочки или скопируйте существующий. Произвольные командные строки не поддерживаются.</p>
          <Field label="Копировать профиль"><select value={duplicate} onChange={e => setDuplicate(e.target.value)}><option value="">Новый профиль</option>{draft.profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>
          {!duplicate && <Field label="Оболочка"><select value={newShell} onChange={e => setNewShell(e.target.value as Shell)}>{(Object.keys(shellNames) as Shell[]).map(shell => <option key={shell} value={shell}>{shellNames[shell]}</option>)}</select></Field>}
          <button type="button" className="settings-workspace-primary" disabled={draft.profiles.length >= MAX_PROFILES} onClick={addProfile}><Plus size={16} />{duplicate ? 'Дублировать профиль' : 'Добавить профиль'}</button>
          {draft.profiles.length >= MAX_PROFILES && <p role="status">Достигнут предел: {MAX_PROFILES} профиля.</p>}
        </>}
        {profile && <>
          <p className="settings-workspace-note">Оболочка, начальный каталог и аргументы применяются только к новым сессиям. Оформление обновляется после сохранения без перезапуска процессов.</p>
          <Field label="Имя профиля"><input value={profile.name} maxLength={128} onChange={e => updateProfile({ name: e.target.value })} /></Field>
          <Field label="Оболочка"><select value={profile.shell} onChange={e => updateProfile({ shell: e.target.value as Shell })}>{(Object.keys(shellNames) as Shell[]).map(shell => <option key={shell} value={shell}>{shellNames[shell]}</option>)}</select></Field>
          {['powershell', 'windows-powershell'].includes(profile.shell) && <Field label="Не загружать профиль PowerShell" hint="Передаёт -NoProfile только новым сессиям."><input type="checkbox" role="switch" checked={profile.noProfile ?? false} onChange={e => updateProfile({ noProfile: e.target.checked })} /></Field>}
          <p className="settings-workspace-note">Поддерживаются только перечисленные оболочки. Произвольные командные строки и аргументы не поддерживаются.</p>
          <Field label="Начальный каталог" hint="Локальная папка Windows; пустое значение — домашний каталог. Linux-пути WSL здесь не поддерживаются."><input value={profile.startingDirectory} maxLength={4096} placeholder="Например, C:\Users\User" onChange={e => updateProfile({ startingDirectory: e.target.value })} /></Field>
          {profile.shell === 'wsl' && <Field label="Дистрибутив WSL" hint="Пустое значение — дистрибутив WSL по умолчанию."><input value={profile.distribution ?? ''} onChange={e => updateProfile({ distribution: e.target.value })} /></Field>}
          <Field label="Скрыть профиль" hint="Скрытые профили не предлагаются при открытии новой вкладки."><input type="checkbox" role="switch" checked={profile.hidden} onChange={e => updateProfile({ hidden: e.target.checked })} /></Field>
          <h2>Переопределения оформления</h2>
          <Field label="Гарнитура шрифта" hint={`Пустое значение — ${draft.fontFamily}`}><input list={fontList} value={profile.fontFamily ?? ''} placeholder="По умолчанию" onChange={e => updateProfile({ fontFamily: e.target.value || undefined })} /></Field>
          <Field label="Размер шрифта" hint={`Пустое значение — ${draft.fontSize}`}><input type="number" min={10} max={28} value={profile.fontSize ?? ''} placeholder="По умолчанию" onChange={e => updateProfile({ fontSize: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label="Цветовая схема">{selectSchemes(profile.colorScheme ?? '', value => updateProfile({ colorScheme: value || undefined }), true)}</Field>
          <h2>Удаление профиля</h2><p className="settings-workspace-note">Удаление вступит в силу после сохранения. Последний профиль удалить нельзя.</p>
          <button type="button" className="settings-workspace-danger" disabled={draft.profiles.length <= 1} onClick={() => { setDraft(normalizeSettings({ ...draft, profiles: draft.profiles.filter(p => p.id !== profile.id) })); navigate('defaults'); }}>Удалить профиль</button>
        </>}
        {section === 'import' && <>
          <p className="settings-workspace-note">Импорт Windows Terminal читает настройки, но никогда не изменяет исходные файлы и не запускает оболочки. Сначала проверьте предпросмотр.</p>
          <Field label="Источник Windows Terminal"><select value={source} disabled={busy || !sources.length} onChange={e => { setSource(e.target.value); setPreview(null); }}><option value="" disabled>Выберите источник</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <div className="settings-workspace-buttons"><button type="button" disabled={busy || !source} onClick={() => void readSource()}>Подготовить предпросмотр</button><button type="button" disabled={busy} onClick={() => { setError(''); setNotice(''); void listSources(); }}>Обновить источники</button></div>
          <h2>Выбрать файл вручную</h2><Field label="Файл Windows Terminal (JSON / JSONC)"><input type="file" accept=".json,.jsonc,application/json" disabled={busy} onChange={e => { void readFile(e.target.files?.[0], true); e.target.value = ''; }} /></Field>
          {busy && <p role="status">Чтение настроек…</p>}
          {preview && <div className="settings-workspace-import-preview"><h2>Предпросмотр импорта</h2><p>Профилей: {preview.importedProfiles}. Цветовых схем: {preview.importedSchemes}.</p>{preview.warnings.length > 0 && <><h3>Предупреждения</h3><ul>{preview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></>}<p>Импорт подготовлен на основе черновика в момент чтения. Применение заменит текущий черновик этим результатом.</p><button type="button" className="settings-workspace-primary" disabled={busy} onClick={() => { setDraft(structuredClone(preview.settings)); setPreview(null); setNotice('Импорт применён к черновику. Для сохранения нажмите «Сохранить».'); }}>Применить к черновику</button></div>}
          <h2>Ограничения совместимости</h2><p className="settings-workspace-note">Поддерживаются известные оболочки, профили и доступные параметры оформления. Произвольные commandline, GPU, расширения, пользовательские действия и другие неподдерживаемые параметры не включаются. Предупреждения импортера описывают пропуски.</p>
          <button type="button" className="settings-workspace-link" onClick={() => navigate('json')}>Импорт собственного JSON OpenTerminal <ChevronRight size={16} /></button>
        </>}
        {section === 'json' && <>
          <p className="settings-workspace-note">JSON текущего черновика OpenTerminal (не JSONC Windows Terminal). После редактирования примените JSON к черновику, затем сохраните настройки.</p>
          <Field label="Импорт JSON OpenTerminal"><input type="file" accept=".json,application/json" disabled={busy} onChange={e => { void readFile(e.target.files?.[0], false); e.target.value = ''; }} /></Field>
          <label className="settings-workspace-json-label">JSON настроек<textarea aria-label="JSON настроек" spellCheck={false} value={json} onChange={e => setJson(e.target.value)} /></label>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(json).then(() => setNotice('JSON скопирован в буфер обмена.')).catch(() => setError('Не удалось скопировать JSON.')); }}>Скопировать JSON</button>
          <button type="button" className="settings-workspace-primary" disabled={busy} onClick={() => { try { const parsed = parseSettingsJson(json); setDraft(parsed); setJson(JSON.stringify(parsed, null, 2)); setError(''); setNotice('JSON применён к черновику. Нажмите «Сохранить», чтобы применить настройки.'); } catch (e) { setError(message(e)); setNotice(''); } }}>Применить JSON</button>
        </>}
      </section>
    </div>
    <footer className="settings-workspace-footer"><button type="button" onClick={() => navigate('json')}><Code2 size={16} /><span>Редактировать JSON</span></button><div><button type="button" className="settings-workspace-primary" onClick={() => { try { const next = normalizeSettings(draft); onSave(next); setDraft(structuredClone(next)); setError(''); setNotice(''); } catch (e) { setError(message(e)); } }}>Сохранить</button><button type="button" onClick={onCancel}>Отменить изменения</button></div></footer>
  </section>;
}
