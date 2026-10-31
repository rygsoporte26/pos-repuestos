import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Contexto } from '../../domain/contexto';
import type { Negocio } from '../../db/types';

// ---------- Contexto de la app (usuario, sede, caja, datos del negocio) ----------
export interface AppState {
  ctx: Contexto;
  negocio: Negocio;
  irA: (pagina: Pagina) => void;
}
export type Pagina = 'vender' | 'caja' | 'ventas' | 'mayor' | 'productos' | 'inventario' | 'panel' | 'ajustes';
export const AppCtx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(AppCtx);
  if (!v) throw new Error('AppCtx no disponible');
  return v;
};

// ---------- Avisos (toasts) ----------
type Toast = { id: number; texto: string; error?: boolean };
const ToastCtx = createContext<(texto: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [lista, setLista] = useState<Toast[]>([]);
  const avisar = useCallback((texto: string, error = false) => {
    const id = Date.now() + Math.random();
    setLista((l) => [...l, { id, texto, error }]);
    setTimeout(() => setLista((l) => l.filter((t) => t.id !== id)), error ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={avisar}>
      {children}
      <div className="toast-zone" role="status" aria-live="polite">
        {lista.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>{t.texto}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Ejecuta una acción y muestra su error de negocio como aviso. */
export function useAccion() {
  const avisar = useToast();
  return useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (ok) avisar(ok);
      return r;
    } catch (e) {
      avisar(e instanceof Error ? e.message : String(e), true);
      return undefined;
    }
  }, [avisar]);
}

// ---------- Modal ----------
export function Modal({ titulo, onClose, children, wide }: { titulo: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-head">
          <h2>{titulo}</h2>
          <button className="x" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Campo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
