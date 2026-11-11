import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Settings, Tab } from './types';
import { terminalFont } from './types';
import { BUILTIN_SCHEMES, schemeToXterm } from './schemes';
import { trapDialogKeyboard } from './dialogs';
import { shortcutKey } from './keyboard';

type TerminalEvent =
  | { type: 'data'; data: number[] }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

const terminalTheme = (settings: Settings) => schemeToXterm(settings.schemes.find((scheme) => scheme.name === settings.colorScheme) ?? BUILTIN_SCHEMES[0]);

export function Terminal({ tab, active, settings, onStatus, onTitle, onFontSizeChange, onNotify }: {
  tab: Tab; active: boolean; settings: Settings;
  onStatus: (id: string, status: string) => void;
  onTitle: (id: string, title: string) => void;
  onFontSizeChange: (id: string, delta: number) => void;
  onNotify: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ terminal: XTerm; fit: FitAddon; resize: () => void } | null>(null);
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const titleCallback = useRef(onTitle);
  titleCallback.current = onTitle;
  const fontSizeCallback = useRef(onFontSizeChange);
  fontSizeCallback.current = onFontSizeChange;
  const notificationCallback = useRef(onNotify);
  notificationCallback.current = onNotify;
  const [pastePrompt, setPastePrompt] = useState<string | null>(null);
  const confirmPaste = useRef<(() => void) | null>(null);
  const liveSettings = useRef(settings);
  liveSettings.current = settings;

  useEffect(() => {
    const terminal = new XTerm({
      fontFamily: terminalFont(settings.fontFamily),
      fontSize: settings.fontSize, lineHeight: settings.lineHeight,
      fontWeight: 'normal', fontWeightBold: 'bold',
      theme: terminalTheme(settings), cursorBlink: settings.cursorBlink, cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback, allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    const titleListener = terminal.onTitleChange((title) => titleCallback.current(tab.id, title));
    let disposed = false;
    let started = false;
    let ended = false;
    let frame = 0;
    let selectionFrame = 0;
    const notify = (message: string) => {
      if (disposed) return;
      notificationCallback.current(message);
    };
    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void navigator.clipboard.writeText(selection).then(() => {
        notify('Текст скопирован');
      }).catch(() => notify('Не удалось скопировать текст'));
    };
    const host = container.current!;
    const paste = (text: string) => {
      if (disposed || ended || !text) return;
      if (text.length > 1024 * 1024) { notify('Слишком большой текст для вставки'); return; }
      if (liveSettings.current.confirmMultilinePaste && /[\r\n]/.test(text)) {
        setPastePrompt(text);
        confirmPaste.current = () => { if (!disposed && !ended) { terminal.paste(text); terminal.focus(); } setPastePrompt(null); confirmPaste.current = null; };
      } else { terminal.paste(text); }
    };
    const readClipboard = () => {
      void navigator.clipboard.readText().then(paste).catch(() => notify('Не удалось вставить текст'));
    };
    const clipboardPaste = (event: ClipboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      paste(event.clipboardData?.getData('text/plain') ?? '');
    };
    const contextMenu = (event: MouseEvent) => {
      if (liveSettings.current.rightClickPaste) { event.preventDefault(); readClipboard(); }
    };
    let selecting = false;
    const beginSelection = (event: MouseEvent) => { selecting = event.button === 0; };
    const select = () => {
      if (!selecting) return;
      selecting = false;
      cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(() => {
        if (!disposed && liveSettings.current.copyOnSelect && terminal.hasSelection()) copySelection();
      });
    };
    host.addEventListener('paste', clipboardPaste, true);
    host.addEventListener('contextmenu', contextMenu);
    host.addEventListener('mousedown', beginSelection, true);
    document.addEventListener('mouseup', select, true);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Capture before xterm handles scrolling, and suppress WebView page zoom.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY !== 0) fontSizeCallback.current(tab.id, event.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', wheel, { capture: true, passive: false });
    const report = (message: string) => statusCallback.current(tab.id, message);
    const fail = (error: unknown) => {
      if (!disposed) {
        terminal.writeln(`\r\n\x1b[31m${String(error).replace(/[\x00-\x1f\x7f]/g, ' ')}\x1b[0m`);
        report('Ошибка');
      }
    };
    const resize = () => {
      if (disposed || !container.current?.clientWidth || !container.current?.clientHeight) return;
      fit.fit();
      if (started && !ended) {
        void invoke('resize_terminal', { id: tab.id, cols: terminal.cols, rows: terminal.rows }).catch(fail);
      }
    };
    runtime.current = { terminal, fit, resize };
    fit.fit();
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (event) => {
      if (disposed) return;
      if (event.type === 'data') terminal.write(new Uint8Array(event.data));
      if (event.type === 'error') fail(event.message);
      if (event.type === 'exit') {
        ended = true;
        report(`Завершён · ${event.code}`);
        terminal.writeln(`\r\n\x1b[90m[Процесс завершён с кодом ${event.code}]\x1b[0m`);
      }
    };
    const creation = invoke<void>('create_terminal', {
      id: tab.id, shell: tab.shell, cols: terminal.cols, rows: terminal.rows, channel,
      startingDirectory: tab.profile.startingDirectory || null, distribution: tab.profile.distribution || null, noProfile: tab.profile.noProfile ?? false,
    }).then(() => {
      started = true;
      if (disposed) {
        void invoke('close_terminal', { id: tab.id }).catch(console.error);
      } else if (!ended) {
        report('Подключён');
        resize();
      }
    }).catch(fail);

    let pendingInput = Promise.resolve();
    const input = terminal.onData((data) => {
      if (ended) return;
      // ConPTY can request the cursor position before create_terminal resolves.
      // Queue xterm's reply rather than dropping the initial handshake.
      pendingInput = pendingInput.then(async () => {
        await creation;
        if (started && !disposed && !ended) await invoke<void>('write_terminal', { id: tab.id, data });
      }).catch(fail);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = shortcutKey(event);
      if (key === 'c') {
        event.preventDefault();
        if ((liveSettings.current.copyOnCtrlC && terminal.hasSelection()) || event.shiftKey) {
          if (!event.repeat) copySelection();
        } else if (!disposed && !ended) {
          // Send ETX explicitly: xterm's layout-dependent keyCode may be stale.
          terminal.input('\x03', true);
        }
        return false;
      }
      if (key === 'v') {
        event.preventDefault();
        if (!event.repeat) readClipboard();
        return false;
      }
      if (key === ',' || (event.shiftKey && ['t', 'w'].includes(key))) return false;
      return true;
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(container.current!);
    return () => {
      disposed = true;
      host.removeEventListener('wheel', wheel, true);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(selectionFrame);
      confirmPaste.current = null;
      host.removeEventListener('paste', clipboardPaste, true);
      host.removeEventListener('contextmenu', contextMenu);
      host.removeEventListener('mousedown', beginSelection, true);
      document.removeEventListener('mouseup', select, true);
      observer.disconnect();
      input.dispose();
      titleListener.dispose();
      runtime.current = null;
      terminal.dispose();
      if (started) void invoke('close_terminal', { id: tab.id }).catch(console.error);
    };
    // A terminal session lives for the lifetime of its tab, not its settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.shell]);

  useEffect(() => {
    if (!runtime.current) return;
    runtime.current.terminal.options.fontSize = settings.fontSize;
    runtime.current.terminal.options.fontFamily = terminalFont(settings.fontFamily);
    runtime.current.terminal.options.theme = terminalTheme(settings);
    runtime.current.terminal.options.cursorStyle = settings.cursorStyle;
    runtime.current.terminal.options.cursorBlink = settings.cursorBlink;
    runtime.current.terminal.options.scrollback = settings.scrollback;
    runtime.current.terminal.options.lineHeight = settings.lineHeight;
    runtime.current.resize();
  }, [settings]);

  useEffect(() => {
    if (active) {
      runtime.current?.resize();
      if (pastePrompt !== null) container.current?.parentElement?.querySelector<HTMLButtonElement>('.paste-confirmation button:last-child')?.focus();
      else runtime.current?.terminal.focus();
    } else { runtime.current?.terminal.blur(); }
  }, [active, pastePrompt]);

  return <div className={`terminal-pane ${active ? 'active' : ''}`} style={{ background: terminalTheme(settings).background }} aria-label={`Терминал ${tab.shell}`}>
    <div ref={container} className="terminal-host" />
    {pastePrompt !== null && <div className="paste-backdrop"><section className="paste-confirmation" role="dialog" aria-modal="true" aria-labelledby={`paste-${tab.id}`} onKeyDown={(event) => trapDialogKeyboard(event, () => { setPastePrompt(null); confirmPaste.current = null; terminalFocus(); })}><h2 id={`paste-${tab.id}`}>Вставить несколько строк?</h2><p>Текст может содержать команды, которые выполнятся сразу после вставки.</p><pre>{pastePrompt.slice(0, 2000)}{pastePrompt.length > 2000 ? '\n…' : ''}</pre><div className="confirm-actions"><button className="primary-button" onClick={() => confirmPaste.current?.()}>Вставить</button><button autoFocus onClick={() => { setPastePrompt(null); confirmPaste.current = null; terminalFocus(); }}>Отмена</button></div></section></div>}
  </div>;

  function terminalFocus() { runtime.current?.terminal.focus(); }
}
