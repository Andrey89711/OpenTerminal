import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Settings, Tab } from './types';

type TerminalEvent =
  | { type: 'data'; data: number[] }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

const themes: Record<Settings['theme'], ITheme> = {
  dark: {
    background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff',
    selectionBackground: '#ffffff40', black: '#0c0c0c', red: '#c50f1f',
    green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798',
    cyan: '#3a96dd', white: '#cccccc', brightBlack: '#767676',
    brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
  },
  light: {
    background: '#ffffff', foreground: '#303448', cursor: '#303448',
    selectionBackground: '#7771cc33', black: '#303448', red: '#b83352',
    green: '#287842', yellow: '#8b650d', blue: '#315db0', magenta: '#8649aa',
    cyan: '#167887', white: '#c8cbd8', brightBlack: '#6f748b',
  },
};

export function Terminal({ tab, active, settings, onStatus, onTitle, onFontSizeChange }: {
  tab: Tab; active: boolean; settings: Settings;
  onStatus: (id: string, status: string) => void;
  onTitle: (id: string, title: string) => void;
  onFontSizeChange: (delta: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ terminal: XTerm; fit: FitAddon; resize: () => void } | null>(null);
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const titleCallback = useRef(onTitle);
  titleCallback.current = onTitle;
  const fontSizeCallback = useRef(onFontSizeChange);
  fontSizeCallback.current = onFontSizeChange;
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const terminal = new XTerm({
      fontFamily: '"Cascadia Mono", Consolas, "Cascadia Code", monospace',
      fontSize: settings.fontSize, lineHeight: 1,
      fontWeight: 'normal', fontWeightBold: 'bold',
      theme: themes[settings.theme], cursorBlink: true, cursorStyle: 'bar',
      scrollback: 10000, allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    const titleListener = terminal.onTitleChange((title) => titleCallback.current(tab.id, title));
    let disposed = false;
    let started = false;
    let ended = false;
    let frame = 0;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const notify = (message: string) => {
      if (disposed) return;
      clearTimeout(noticeTimer);
      setNotice(message);
      noticeTimer = setTimeout(() => setNotice(null), 2000);
    };
    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void navigator.clipboard.writeText(selection).then(() => {
        notify('Copied to clipboard');
      }).catch(() => notify('Copy failed'));
    };
    const host = container.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Capture before xterm handles scrolling, and suppress WebView page zoom.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY !== 0) fontSizeCallback.current(event.deltaY < 0 ? 1 : -1);
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
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' && (terminal.hasSelection() || event.shiftKey)) {
        event.preventDefault();
        if (!event.repeat) copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && ['c', 'v', 't', 'w', ','].includes(event.key.toLowerCase())) {
        if (event.key.toLowerCase() === 'v') {
          void navigator.clipboard.readText().then((text) => { if (!disposed && !ended) terminal.paste(text); }).catch(fail);
        }
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(container.current!);
    return () => {
      disposed = true;
      clearTimeout(noticeTimer);
      host.removeEventListener('wheel', wheel, true);
      cancelAnimationFrame(frame);
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
    runtime.current.terminal.options.theme = themes[settings.theme];
    runtime.current.resize();
  }, [settings]);

  useEffect(() => {
    if (active) {
      runtime.current?.resize();
      runtime.current?.terminal.focus();
    }
  }, [active]);

  return <div className={`terminal-pane ${active ? 'active' : ''}`} aria-label={`Терминал ${tab.shell}`}>
    <div ref={container} className="terminal-host" />
    {notice && <div className={`terminal-notice ${notice === 'Copy failed' ? 'error' : ''}`} role="status">{notice}</div>}
  </div>;
}
