import { X } from 'lucide-react';
import { useEffect } from 'react';

export const Modal = ({ open, onClose, title, children }: {
  open: boolean;
  onClose?: (() => void) | undefined;
  title: string;
  children: React.ReactNode;
}) => {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, open]);
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose?.();
  }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><h2>{title}</h2>{onClose && <button onClick={onClose} aria-label="閉じる"><X size={20} /></button>}</div>
      {children}
    </section>
  </div>;
};
