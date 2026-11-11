import type { KeyboardEvent } from 'react';

export function trapDialogKeyboard(event: KeyboardEvent<HTMLElement>, cancel: () => void) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
  if (!controls.length) { event.preventDefault(); return; }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
