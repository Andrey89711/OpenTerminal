import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { themes } from './Terminal';
import { terminalFont, type Settings, type Tab } from './types';

type Discovery = { path: string; version: string; dev_fallback: boolean };
type Preview = { theme: string; ansi: string; text: string };
type PromptTheme = 'minimal' | 'classic' | 'blocks';

function AnsiPreview({ ansi, settings }: { ansi: string; settings: Settings }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new XTerm({
      disableStdin: true, cursorBlink: false, scrollback: 0, convertEol: true,
      fontFamily: terminalFont(settings.fontFamily), fontSize: settings.fontSize,
      theme: themes[settings.theme], allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    terminal.attachCustomKeyEventHandler(() => false);
    fit.fit();
    terminal.write(ansi);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    return () => { observer.disconnect(); terminal.dispose(); };
  }, [ansi, settings.fontFamily, settings.fontSize, settings.theme]);
  return <div className="prompt-preview" aria-label="ANSI-предпросмотр OpenPrompt" ref={host} />;
}

export function OpenPromptSettings({ settings, onPathChange, activeTab, connected }: {
  settings: Settings; onPathChange: (path: string) => void; activeTab?: Tab; connected: boolean;
}) {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [theme, setTheme] = useState<PromptTheme>('classic');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [searching, setSearching] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ script: string; tabId: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiscovery(null); setPreview(null); setConfirmation(null); setConfirmed(false);
    setError(''); setMessage(''); setSearching(true);
    const timer = setTimeout(() => {
      void invoke<Discovery>('discover_openprompt', { configuredPath: settings.promptPath || null })
        .then((found) => { if (!cancelled) setDiscovery(found); })
        .catch((reason) => { if (!cancelled) setError(String(reason)); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settings.promptPath, retry]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError(''); setMessage('');
    if (discovery) {
      void invoke<Preview>('openprompt_preview', { path: discovery.path, theme })
        .then((value) => { if (!cancelled) setPreview(value); })
        .catch((reason) => { if (!cancelled) setError(String(reason)); });
    }
    return () => { cancelled = true; };
  }, [discovery, theme]);

  useEffect(() => { setConfirmation(null); setConfirmed(false); }, [activeTab?.id]);

  const save = async () => {
    if (!discovery) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await invoke('openprompt_set_theme', { path: discovery.path, theme });
      setMessage(`Тема ${theme} сохранена в OpenPrompt.`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const prepare = async () => {
    if (!discovery || activeTab?.shell !== 'powershell' || !connected) return;
    setBusy(true); setError(''); setMessage(''); setConfirmed(false);
    try {
      const script = await invoke<string>('openprompt_session_script', { path: discovery.path });
      setConfirmation({ script, tabId: activeTab.id });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const enable = async () => {
    if (!confirmed || !confirmation || activeTab?.id !== confirmation.tabId || activeTab.shell !== 'powershell' || !connected) return;
    setBusy(true); setError('');
    // Consume this explicit approval before sending; it cannot enable a later tab/session.
    setConfirmation(null); setConfirmed(false);
    try {
      await invoke('write_terminal', { id: confirmation.tabId, data: confirmation.script });
      setMessage('Команда отправлена в текущую сессию PowerShell. Профиль не изменён.');
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="prompt-settings" aria-labelledby="prompt-title">
    <h3 id="prompt-title">OpenPrompt</h3>
    <p className="settings-note">OpenPrompt 0.2+. Предпросмотр не меняет настройки. Профили PowerShell и автозапуск не изменяются.</p>
    <label className="prompt-path">Путь к OpenPrompt (необязательно)<input value={settings.promptPath} disabled={busy} placeholder="Автопоиск в PATH и ~/.cargo/bin" onChange={(event) => onPathChange(event.target.value)} /></label>
    <button className="secondary-button" disabled={searching || busy} onClick={() => setRetry((value) => value + 1)}>Найти OpenPrompt</button>
    {searching && <p className="settings-note">Поиск OpenPrompt…</p>}
    {discovery && <p className="prompt-found">{discovery.version}<small>{discovery.path}</small>{discovery.dev_fallback && <small>Найдена локальная сборка для разработки (dev fallback).</small>}</p>}
    <label className="setting-row"><span>Тема OpenPrompt</span><select value={theme} disabled={busy} onChange={(event) => setTheme(event.target.value as PromptTheme)}><option value="minimal">minimal</option><option value="classic">classic</option><option value="blocks">blocks</option></select></label>
    {preview && <AnsiPreview ansi={preview.ansi} settings={settings} />}
    <div className="prompt-actions"><button className="secondary-button" disabled={!discovery || busy || !preview} onClick={() => void save()}>Сохранить тему</button><button className="secondary-button" disabled={!discovery || busy || !connected || activeTab?.shell !== 'powershell'} onClick={() => void prepare()}>Включить в текущей сессии…</button></div>
    <p className="settings-note">Включение доступно только в подключённой сессии PowerShell. Выполняйте команду на свободной строке приглашения, не внутри другой программы. Используйте только доверенный файл OpenPrompt.</p>
    {confirmation && confirmation.tabId === activeTab?.id && <div className="prompt-confirmation">
      <p>В текущую сессию PowerShell будет отправлена команда:</p>
      <pre>{confirmation.script.replace(/\r$/, '')}</pre>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Подтверждаю выполнение этой команды в текущей сессии</label>
      <div className="prompt-actions"><button className="secondary-button" disabled={!confirmed || busy || !connected} onClick={() => void enable()}>Выполнить команду</button><button className="secondary-button" onClick={() => { setConfirmation(null); setConfirmed(false); }}>Отмена</button></div>
    </div>}
    {error && <p className="prompt-error" role="alert">{error}</p>}
    {message && <p className="prompt-message" role="status">{message}</p>}
  </section>;
}
