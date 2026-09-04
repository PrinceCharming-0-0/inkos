import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, XCircle, X } from "lucide-react";

export type ToastKind = "success" | "error";

export interface ToastItem {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  /** Optional second line of info */
  readonly detail?: string;
}

// --- Hook ---

export function useToasts() {
  const [toasts, setToasts]: [ReadonlyArray<ToastItem>, Dispatch<SetStateAction<ReadonlyArray<ToastItem>>>] = useState<ReadonlyArray<ToastItem>>([]);
  const counterRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string, durationMs?: number) => {
      const id = ++counterRef.current;
      const duration = durationMs ?? (kind === "success" ? 4500 : 8000);
      setToasts((prev) => [...prev, { id, kind, message, detail }]);
      const timer = setTimeout(() => dismiss(id), duration);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  const success = useCallback(
    (message: string, detail?: string) => push("success", message, detail),
    [push],
  );
  const error = useCallback(
    (message: string, detail?: string) => push("error", message, detail),
    [push],
  );

  return { toasts, dismiss, success, error };
}

// --- Viewport ---

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ReadonlyArray<ToastItem>;
  onDismiss: (id: number) => void;
}) {
  if (typeof document === "undefined" || toasts.length === 0) return null;

  return createPortal(
    <div
      className="fixed bottom-6 right-6 z-[120] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg max-w-sm w-full animate-slide-up ${
            t.kind === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-destructive/5 border-destructive/20 text-destructive"
          }`}
        >
          {t.kind === "success" ? (
            <CheckCircle2 size={16} className="text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <XCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-snug">{t.message}</p>
            {t.detail && (
              <p className="text-xs mt-0.5 opacity-75">{t.detail}</p>
            )}
          </div>
          <button
            onClick={() => onDismiss(t.id)}
            className="shrink-0 p-0.5 rounded hover:bg-black/10 transition-colors"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
