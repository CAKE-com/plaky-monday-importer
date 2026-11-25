"use client";

import { useCallback, useId, useRef, useState } from "react";
import { buttonClass, Mark, Plain } from "./bits";

const STILL_DISABLED_RETRY_MS = 50;

function focusOnceEnabled(target: HTMLElement | null): void {
  target?.focus();
  if (target && document.activeElement !== target) setTimeout(() => target.focus(), STILL_DISABLED_RETRY_MS);
}

export function ConfirmDialog({ title, text, confirmLabel, cancelLabel, pending, returnFocus, onConfirm, onCancel, testId }: {
  title: string; text: string; confirmLabel: string; cancelLabel: string; pending: boolean;
  returnFocus: () => HTMLElement | null; onConfirm: () => void; onCancel: () => void; testId?: string;
}) {
  const ids = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const [back] = useState(() => returnFocus);
  const openModal = useCallback((dialog: HTMLDialogElement) => {
    if (!dialog.open) dialog.showModal();
    safe.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      focusOnceEnabled(back());
    };
  }, [back]);
  return (
    <dialog ref={openModal} role="alertdialog" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-text`} data-testid={testId}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="m-auto w-[min(520px,calc(100vw-2rem))] rounded-lg border border-cake-line bg-white p-6 text-cake-ink backdrop:bg-black/40">
      <div className="flex flex-col gap-3">
        <p id={`${ids}-title`} className="flex items-start gap-2"><Mark kind="flag" /><strong>{title}</strong></p>
        <p id={`${ids}-text`} className="text-sm text-cake-muted">{text}</p>
        <div className="flex flex-wrap gap-4">
          <button type="button" ref={safe} onClick={onCancel} className={buttonClass.quiet}>{cancelLabel}</button>
          <Plain onClick={onConfirm} disabled={pending}>{confirmLabel}</Plain>
        </div>
      </div>
    </dialog>
  );
}
