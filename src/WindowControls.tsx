import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const desktop = isTauri();

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = () => {
      void appWindow.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      }).catch(console.error);
    };
    update();
    void appWindow.onResized(update).then((cleanup) => {
      if (disposed) cleanup(); else unlisten = cleanup;
    }).catch(console.error);
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);

  return <div className="window-controls">
    <button disabled={!desktop} className="caption-button" aria-label="Свернуть" title="Свернуть" onClick={() => void getCurrentWindow().minimize().catch(console.error)}><Minus size={12} strokeWidth={1} /></button>
    <button disabled={!desktop} className="caption-button" aria-label={maximized ? 'Восстановить' : 'Развернуть'} title={maximized ? 'Восстановить' : 'Развернуть'} onClick={() => void getCurrentWindow().toggleMaximize().catch(console.error)}>{maximized ? <Copy size={11} strokeWidth={1} /> : <Square size={10} strokeWidth={1} />}</button>
    <button disabled={!desktop} className="caption-button caption-close" aria-label="Закрыть окно" title="Закрыть" onClick={() => void getCurrentWindow().close().catch(console.error)}><X size={14} strokeWidth={1} /></button>
  </div>;
}
