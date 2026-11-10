import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Plus, Settings2, TerminalSquare, X } from 'lucide-react';
import { Terminal } from './Terminal';
import { WindowControls } from './WindowControls';
import { shellNames, type Settings, type Shell, type Tab } from './types';

function loadSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem('openterminal.settings') ?? '{}');
    return {
      fontSize: typeof value.fontSize === 'number' ? Math.min(28, Math.max(10, value.fontSize)) : 14,
      theme: value.theme === 'light' ? 'light' : 'dark',
    };
  } catch { return { fontSize: 14, theme: 'dark' }; }
}

const firstTab: Tab = { id: crypto.randomUUID(), shell: 'powershell' };

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([firstTab]);
  const [activeId, setActiveId] = useState(firstTab.id);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});

  const addTab = useCallback((shell: Shell = 'powershell') => {
    const tab = { id: crypto.randomUUID(), shell };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setMenuOpen(false);
  }, []);

  const closeTab = useCallback((id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[Math.max(0, index - 1)]?.id ?? '');
    setStatuses((current) => { const next = { ...current }; delete next[id]; return next; });
    setTitles((current) => { const next = { ...current }; delete next[id]; return next; });
  }, [tabs, activeId]);

  const onStatus = useCallback((id: string, status: string) => {
    setStatuses((current) => ({ ...current, [id]: status }));
  }, []);

  const onTitle = useCallback((id: string, title: string) => {
    setTitles((current) => ({ ...current, [id]: title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) }));
  }, []);

  const onFontSizeChange = useCallback((delta: number) => {
    setSettings((current) => {
      const fontSize = Math.min(28, Math.max(10, current.fontSize + delta));
      return fontSize === current.fontSize ? current : { ...current, fontSize };
    });
  }, []);

  useEffect(() => {
    localStorage.setItem('openterminal.settings', JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSettingsOpen(false); setMenuOpen(false); }
      if (!event.ctrlKey || !event.shiftKey) return;
      switch (event.key.toLowerCase()) {
        case 't': event.preventDefault(); addTab(); break;
        case 'w': event.preventDefault(); if (activeId) closeTab(activeId); break;
        case ',': event.preventDefault(); setSettingsOpen((open) => !open); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addTab, closeTab, activeId]);

  return (
    <main className="app">
      <header className="titlebar" data-tauri-drag-region>
      <nav className="tabbar" aria-label="Сессии терминала">
        <div className="tabs" role="tablist">
          {tabs.map((tab) => <div className={`tab ${activeId === tab.id ? 'selected' : ''}`} key={tab.id}>
            <button role="tab" aria-selected={activeId === tab.id} className="tab-select" title={`${titles[tab.id] || shellNames[tab.shell]} — ${statuses[tab.id] ?? 'Подключение…'}`} onClick={() => setActiveId(tab.id)}><TerminalSquare className={`shell-icon ${tab.shell}`} size={15} strokeWidth={1.5} /><span>{titles[tab.id] || shellNames[tab.shell]}</span></button>
            <button className="tab-close" aria-label={`Закрыть ${shellNames[tab.shell]}`} onClick={() => closeTab(tab.id)}><X size={13} /></button>
          </div>)}
        </div>
        <div className="new-tab-controls">
          <button className="icon-button" onClick={() => addTab()} title="Новая вкладка (Ctrl+Shift+T)" aria-label="Новая вкладка"><Plus size={18} /></button>
          <button className="icon-button small" onClick={() => setMenuOpen(!menuOpen)} aria-label="Выбрать оболочку" aria-expanded={menuOpen}><ChevronDown size={14} /></button>
          {menuOpen && <><div className="menu-dismiss" onClick={() => setMenuOpen(false)} /><div className="shell-menu" aria-label="Профили и настройки">{(Object.keys(shellNames) as Shell[]).map((shell) => <button key={shell} onClick={() => addTab(shell)}><TerminalSquare className={`shell-icon ${shell}`} size={15} />{shellNames[shell]}</button>)}<div className="menu-separator" /><button onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={15} />Параметры<kbd>Ctrl Shift ,</kbd></button></div></>}
        </div>
      </nav>
      <div className="titlebar-drag" data-tauri-drag-region />
      <WindowControls />
      </header>
      <section className="workspace">
        {tabs.map((tab) => <Terminal key={tab.id} tab={tab} active={activeId === tab.id} settings={settings} onStatus={onStatus} onTitle={onTitle} onFontSizeChange={onFontSizeChange} />)}
        {!tabs.length && <div className="empty-state"><div className="empty-icon"><TerminalSquare size={32} /></div><h1>Место для ваших команд.</h1><p>Откройте терминал и начните работу.</p><button className="primary-button" onClick={() => addTab()}><Plus size={16} />Новая сессия</button><kbd>Ctrl + Shift + T</kbd></div>}
      </section>
      {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="settings-heading"><div><div className="eyebrow">OpenTerminal</div><h2 id="settings-title">Параметры</h2></div><button className="icon-button" autoFocus aria-label="Закрыть настройки" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
        <label className="setting-row"><span>Размер шрифта<small>Cascadia Mono / Consolas</small></span><select value={settings.fontSize} onChange={(event) => setSettings({ ...settings, fontSize: Number(event.target.value) })}>{Array.from({ length: 19 }, (_, i) => i + 10).map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
        <label className="setting-row"><span>Оформление<small>Цвета интерфейса и терминала</small></span><select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as Settings['theme'] })}><option value="dark">Тёмное</option><option value="light">Светлое</option></select></label>
        <div className="shortcuts"><div className="eyebrow">ГОРЯЧИЕ КЛАВИШИ</div><p>Новая вкладка <kbd>Ctrl Shift T</kbd></p><p>Закрыть вкладку <kbd>Ctrl Shift W</kbd></p><p>Размер шрифта <kbd>Ctrl + колесо</kbd></p><p>Копировать выделение <kbd>Ctrl C</kbd></p><p>Копировать / вставить <kbd>Ctrl Shift C / V</kbd></p><p>Остановить без выделения <kbd>Ctrl C</kbd></p></div>
        <p className="settings-note">Настройки сохраняются автоматически на этом устройстве.</p>
      </section></div>}
    </main>
  );
}
