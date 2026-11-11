import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { ChevronDown, Plus, Settings2, TerminalSquare, X } from 'lucide-react';
import { Terminal } from './Terminal';
import { WindowControls } from './WindowControls';
import { SettingsPage } from './SettingsPage';
import { loadSettings, normalizeSettings, resolveTerminalSettings, STORAGE_KEY } from './settings';
import type { Profile, Settings, Tab } from './types';
import { trapDialogKeyboard } from './dialogs';
import { shortcutKey } from './keyboard';

const SETTINGS_TAB = '__settings__';
const bootSettings = loadSettings();
const initialProfile = bootSettings.profiles.find((profile) => profile.id === bootSettings.defaultProfile)!;
const firstTab: Tab = { id: crypto.randomUUID(), shell: initialProfile.shell, profile: structuredClone(initialProfile) };

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([firstTab]);
  const [activeId, setActiveId] = useState(firstTab.id);
  const [settings, setSettings] = useState<Settings>(bootSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [closeRequested, setCloseRequested] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeId = useRef(0);
  const notify = useCallback((text: string) => setNotice({ id: ++noticeId.current, text }), []);
  const closePolicy = useRef({ enabled: settings.confirmClose, count: tabs.length });
  closePolicy.current = { enabled: settings.confirmClose, count: tabs.length };
  const allowClose = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  const saveSettings = useCallback((next: Settings) => {
    const normalized = normalizeSettings(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); }
    catch { setNotice(null); throw new Error('Не удалось сохранить настройки: локальное хранилище недоступно или заполнено.'); }
    setSettings(normalized); setStorageError(''); notify('Настройки сохранены');
  }, [notify]);

  const openSettings = useCallback(() => {
    setSettingsOpen(true); setActiveId(SETTINGS_TAB); setMenuOpen(false);
  }, []);

  const addTab = useCallback((selected?: Profile) => {
    const profile = selected ?? settings.profiles.find((candidate) => candidate.id === settings.defaultProfile)!;
    const tab: Tab = { id: crypto.randomUUID(), shell: profile.shell, profile: structuredClone(profile) };
    setTabs((current) => [...current, tab]); setActiveId(tab.id); setMenuOpen(false);
  }, [settings.defaultProfile, settings.profiles]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false); setActiveId(tabs[tabs.length - 1]?.id ?? '');
  }, [tabs]);

  const closeTab = useCallback((id: string) => {
    if (id === SETTINGS_TAB) { closeSettings(); return; }
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[Math.max(0, index - 1)]?.id ?? (settingsOpen ? SETTINGS_TAB : ''));
    setStatuses((current) => { const next = { ...current }; delete next[id]; return next; });
    setTitles((current) => { const next = { ...current }; delete next[id]; return next; });
  }, [tabs, activeId, settingsOpen, closeSettings]);

  const onStatus = useCallback((id: string, status: string) => setStatuses((current) => ({ ...current, [id]: status })), []);
  const onTitle = useCallback((id: string, title: string) => setTitles((current) => ({ ...current, [id]: title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) })), []);
  const onFontSizeChange = useCallback((id: string, delta: number) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    setSettings((current) => {
      const profile = current.profiles.find((candidate) => candidate.id === tab?.profile.id);
      if (profile?.fontSize !== undefined) {
        return { ...current, profiles: current.profiles.map((candidate) => candidate.id === profile.id ? { ...candidate, fontSize: Math.min(28, Math.max(10, profile.fontSize! + delta)) } : candidate) };
      }
      const fontSize = Math.min(28, Math.max(10, current.fontSize + delta));
      return fontSize === current.fontSize ? current : { ...current, fontSize };
    });
  }, [tabs]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); setStorageError(''); }
    catch { setStorageError('Не удалось сохранить настройки: локальное хранилище недоступно или заполнено.'); }
    const media = matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => { document.documentElement.dataset.theme = settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme; };
    applyTheme(); media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [settings]);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    const applyLaunch = async () => {
      if (bootSettings.initialWidth !== 1120 || bootSettings.initialHeight !== 740) await window.setSize(new LogicalSize(bootSettings.initialWidth, bootSettings.initialHeight));
      if (bootSettings.launchMode === 'maximized') await window.maximize();
    };
    void applyLaunch().catch(console.error);
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void window.onCloseRequested((event) => {
      if (!allowClose.current && closePolicy.current.enabled && closePolicy.current.count > 0) {
        event.preventDefault(); setCloseRequested(true);
      }
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(console.error);
    return () => { disposed = true; cleanup?.(); };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); setCloseRequested(false); }
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = shortcutKey(event);
      if (key === ',') { event.preventDefault(); openSettings(); return; }
      if (!event.shiftKey) return;
      if (key === 't') { event.preventDefault(); addTab(); }
      if (key === 'w') { event.preventDefault(); if (activeId) closeTab(activeId); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addTab, closeTab, activeId, openSettings]);

  return <main className={`app tabs-${settings.tabWidthMode}`}>
    <header className="titlebar" data-tauri-drag-region>
      <nav className="tabbar" aria-label="Сессии терминала">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => {
            const name = settings.profiles.find((profile) => profile.id === tab.profile.id)?.name ?? tab.profile.name;
            const title = (settings.useShellTitle && titles[tab.id]) || name;
            return <div className={`tab ${activeId === tab.id ? 'selected' : ''}`} key={tab.id}>
              <button role="tab" aria-selected={activeId === tab.id} className="tab-select" title={`${title} — ${statuses[tab.id] ?? 'Подключение…'}`} onClick={() => setActiveId(tab.id)}><TerminalSquare className={`shell-icon ${tab.shell}`} size={15} strokeWidth={1.5} /><span>{title}</span></button>
              <button className="tab-close" aria-label={`Закрыть ${name}`} onClick={() => closeTab(tab.id)}><X size={13} /></button>
            </div>;
          })}
          {settingsOpen && <div className={`tab settings-tab ${activeId === SETTINGS_TAB ? 'selected' : ''}`}>
            <button role="tab" aria-selected={activeId === SETTINGS_TAB} className="tab-select" onClick={() => setActiveId(SETTINGS_TAB)}><Settings2 size={15} /><span>Параметры</span></button>
            <button className="tab-close" aria-label="Закрыть настройки" onClick={closeSettings}><X size={13} /></button>
          </div>}
        </div>
        <div className="new-tab-controls">
          <button className="icon-button" onClick={() => addTab()} title="Новая вкладка (Ctrl+Shift+T)" aria-label="Новая вкладка"><Plus size={18} /></button>
          <button className="icon-button small" onClick={() => setMenuOpen(!menuOpen)} aria-label="Выбрать оболочку" aria-expanded={menuOpen}><ChevronDown size={14} /></button>
          {menuOpen && <><div className="menu-dismiss" onClick={() => setMenuOpen(false)} /><div className="shell-menu" aria-label="Профили и настройки">
            {settings.profiles.filter((profile) => !profile.hidden).map((profile) => <button key={profile.id} onClick={() => addTab(profile)}><TerminalSquare className={`shell-icon ${profile.shell}`} size={15} />{profile.name}</button>)}
            <div className="menu-separator" /><button onClick={openSettings}><Settings2 size={15} />Параметры<kbd>Ctrl ,</kbd></button>
          </div></>}
        </div>
      </nav>
      <div className="titlebar-drag" data-tauri-drag-region /><WindowControls />
    </header>
    <section className="workspace">
      {tabs.map((tab) => <Terminal key={tab.id} tab={tab} active={activeId === tab.id} settings={resolveTerminalSettings(settings, tab.profile)} onStatus={onStatus} onTitle={onTitle} onFontSizeChange={onFontSizeChange} onNotify={notify} />)}
      {settingsOpen && <div className={`settings-pane ${activeId === SETTINGS_TAB ? 'active' : ''}`}><SettingsPage settings={settings} onSave={saveSettings} onCancel={closeSettings} /></div>}
      {!tabs.length && activeId !== SETTINGS_TAB && <div className="empty-state"><div className="empty-icon"><TerminalSquare size={32} /></div><h1>Место для ваших команд.</h1><p>Откройте терминал и начните работу.</p><button className="primary-button" onClick={() => addTab()}><Plus size={16} />Новая сессия</button><kbd>Ctrl + Shift + T</kbd></div>}
      {notice && <div className="app-notice" role="status" aria-live="polite" aria-atomic="true">{notice.text}</div>}
    </section>
    {storageError && <div className="storage-error" role="alert">{storageError}</div>}
    {closeRequested && <div className="modal-backdrop"><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="close-title" onKeyDown={(event) => trapDialogKeyboard(event, () => setCloseRequested(false))}><h2 id="close-title">Закрыть терминал?</h2><p>Все открытые сессии и выполняемые в них процессы будут завершены.</p><div className="confirm-actions"><button className="primary-button" onClick={() => { allowClose.current = true; void getCurrentWindow().close().catch(console.error); }}>Закрыть окно</button><button autoFocus onClick={() => setCloseRequested(false)}>Отмена</button></div></section></div>}
  </main>;
}
