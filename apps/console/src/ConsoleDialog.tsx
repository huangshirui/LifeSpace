import { useEffect, useId, useRef, type ReactNode } from "react";

/** Dedicated editor/list dialog. Native modal provides keyboard focus isolation and restoration. */
export function ConsoleDialog({ title, description, children, footer, onClose, busy = false, compact = false }: {
  title: string; description?: string; children: ReactNode; footer: ReactNode;
  onClose: () => void; busy?: boolean; compact?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className={"cp-dialog console-modal" + (compact ? " console-modal-compact" : "")}
    aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="cp-dialog-header">
      <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
      <button type="button" className="cp-icon-button" disabled={busy} onClick={onClose} aria-label="关闭">×</button>
    </header>
    <div className="cp-dialog-body">{children}</div>
    <footer className="cp-dialog-footer">{footer}</footer>
  </dialog>;
}
