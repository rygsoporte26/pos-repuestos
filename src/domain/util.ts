export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/** Redondeo a centavos sin errores de coma flotante típicos (1.005 → 1.01). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Acepta "2,50", "2.50", " 3 " → número; vacío o inválido → null. */
export function parseNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = v.trim().replace(/\s/g, '');
  if (s === '') return null;
  // "1.234,56" → 1234.56 ; "1234,56" → 1234.56 ; "1234.56" → 1234.56
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

export function parseEntero(v: string | number | null | undefined): number | null {
  const n = parseNum(v);
  return n === null || !Number.isInteger(n) ? null : n;
}

const fmt = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `$ ${fmt.format(n)}`);
export const num2 = (n: number): string => fmt.format(n);

/** Fecha local YYYY-MM-DD (no UTC: en Venezuela la noche ya es el día siguiente en UTC). */
export function diaLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const hora = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

export const fechaHora = (iso: string): string =>
  new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Mayúsculas sin tildes, para buscar "bujia" y encontrar "BUJÍA". */
export const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

export const bs = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `Bs ${fmt.format(n)}`);
/** Monto en su moneda: "$ 10,00" o "Bs 2.103,70". */
export const enMoneda = (n: number, moneda: 'USD' | 'VES') => (moneda === 'USD' ? usd(n) : bs(n));
