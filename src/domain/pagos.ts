import type { MedioPago, Moneda, Pago } from '../db/types';
import { ErrorNegocio } from './contexto';
import { round2, uuid } from './util';

export interface InfoMedio {
  codigo: MedioPago;
  nombre: string;
  corto: string; // como lo anota la tienda
  moneda: Moneda;
  referencia: boolean; // número de referencia obligatorio
  efectivo: boolean; // se cuenta en el arqueo
  vuelto: boolean; // se puede dar vuelto por este medio
}

/** Métodos de pago de la tienda (en el orden de la hoja del papá). */
export const MEDIOS: InfoMedio[] = [
  { codigo: 'efectivo_bs', nombre: 'Efectivo bolívares', corto: 'Bs', moneda: 'VES', referencia: false, efectivo: true, vuelto: true },
  { codigo: 'efectivo_usd', nombre: 'Efectivo divisa', corto: '$', moneda: 'USD', referencia: false, efectivo: true, vuelto: true },
  { codigo: 'punto_venta', nombre: 'Punto de venta', corto: 'PV', moneda: 'VES', referencia: true, efectivo: false, vuelto: false },
  { codigo: 'biopago', nombre: 'Biopago', corto: 'Bio', moneda: 'VES', referencia: true, efectivo: false, vuelto: false },
  { codigo: 'pago_movil', nombre: 'Pago móvil', corto: 'PM', moneda: 'VES', referencia: true, efectivo: false, vuelto: true },
  { codigo: 'binance', nombre: 'Binance', corto: 'Bin', moneda: 'USD', referencia: true, efectivo: false, vuelto: false },
];
export const medio = (c: MedioPago): InfoMedio => MEDIOS.find((m) => m.codigo === c) ?? MEDIOS[1];

/** Ventas de la versión 1.0 no tenían moneda ni tipo: eran efectivo en dólares. */
export function normalizarPago(p: Pago): Pago {
  return {
    ...p,
    tipo: p.tipo ?? 'pago',
    moneda: p.moneda ?? 'USD',
    montoMoneda: p.montoMoneda ?? p.monto,
    tasa: p.tasa ?? null,
    referencia: p.referencia ?? null,
  };
}

/** Equivalente en USD de un monto en la moneda del medio. */
export function aUsd(montoMoneda: number, moneda: Moneda, tasa: number | null): number {
  if (moneda === 'USD') return round2(montoMoneda);
  if (!tasa || tasa <= 0) throw new ErrorNegocio('Falta la tasa BCV del día para cobrar en bolívares');
  return round2(montoMoneda / tasa);
}

export const aBs = (usd: number, tasa: number) => round2(usd * tasa);

/** Lo que el vendedor anota: método, monto en su moneda y referencia. */
export interface EntradaPago {
  medio: MedioPago;
  montoMoneda: number;
  referencia?: string;
}

export interface Vuelto {
  medio: MedioPago; // efectivo_usd, efectivo_bs o pago_movil
}

/**
 * Diferencia que se tolera al convertir Bs → USD (redondeo a céntimos): un pago en Bs
 * que cubre el saldo a la tasa del día puede quedar 1 centavo arriba o abajo.
 */
const TOLERANCIA = 0.01;

export interface EstadoCobro {
  pagado: number; // USD
  falta: number; // USD (0 si ya cubre)
  exceso: number; // USD a devolver (0 si no sobra)
}

export function estadoCobro(total: number, entradas: EntradaPago[], tasa: number | null): EstadoCobro {
  const pagado = round2(entradas.reduce((a, e) => a + aUsd(e.montoMoneda, medio(e.medio).moneda, tasa), 0));
  const dif = round2(pagado - total);
  if (Math.abs(dif) <= TOLERANCIA) return { pagado, falta: 0, exceso: 0 };
  return dif < 0 ? { pagado, falta: -dif, exceso: 0 } : { pagado, falta: 0, exceso: dif };
}

/** Monto sugerido para completar el saldo con un medio, en su moneda. */
export function saldoEn(falta: number, m: MedioPago, tasa: number | null): number | null {
  if (medio(m).moneda === 'USD') return round2(falta);
  return tasa ? aBs(falta, tasa) : null;
}

/**
 * Convierte lo anotado en los pagos definitivos de la venta. Garantiza que la suma de
 * "monto" (USD) sea EXACTAMENTE el total: el redondeo de la conversión se ajusta en el
 * último pago, y lo que sobra se registra como vuelto (pago negativo) por el medio elegido.
 */
export function armarPagos(total: number, entradas: EntradaPago[], tasa: number | null, vuelto?: Vuelto): Pago[] {
  const validas = entradas.filter((e) => e.montoMoneda > 0);
  if (validas.length === 0) throw new ErrorNegocio('Agrega al menos un pago');
  for (const e of validas) {
    const m = medio(e.medio);
    if (m.referencia && !e.referencia?.trim()) throw new ErrorNegocio(`Falta la referencia de ${m.nombre}`);
    if (m.moneda === 'VES' && (!tasa || tasa <= 0)) throw new ErrorNegocio('Falta la tasa BCV del día para cobrar en bolívares');
  }
  const est = estadoCobro(total, validas, tasa);
  if (est.falta > 0) throw new ErrorNegocio(`Falta cobrar $ ${est.falta.toFixed(2)}`);

  const pagos: Pago[] = validas.map((e) => {
    const m = medio(e.medio);
    return {
      id: uuid(), medio: e.medio, tipo: 'pago', moneda: m.moneda, montoMoneda: round2(e.montoMoneda),
      tasa: m.moneda === 'VES' ? tasa : null, monto: aUsd(e.montoMoneda, m.moneda, tasa), referencia: e.referencia?.trim() || null,
    };
  });

  if (est.exceso > 0) {
    if (!vuelto) throw new ErrorNegocio(`Hay que dar vuelto de $ ${est.exceso.toFixed(2)}: elige cómo`);
    const mv = medio(vuelto.medio);
    if (!mv.vuelto) throw new ErrorNegocio(`No se da vuelto por ${mv.nombre}`);
    if (mv.moneda === 'VES' && (!tasa || tasa <= 0)) throw new ErrorNegocio('Falta la tasa BCV del día para dar vuelto en bolívares');
    pagos.push({
      id: uuid(), medio: vuelto.medio, tipo: 'vuelto', moneda: mv.moneda,
      montoMoneda: -(mv.moneda === 'USD' ? est.exceso : aBs(est.exceso, tasa!)), tasa: mv.moneda === 'VES' ? tasa : null,
      monto: -est.exceso, referencia: null,
    });
  }
  // Ajuste de centavos: la suma de montos USD debe ser exactamente el total.
  const suma = round2(pagos.reduce((a, p) => a + p.monto, 0));
  const ajuste = round2(total - suma);
  if (ajuste !== 0) {
    const ultimo = [...pagos].reverse().find((p) => p.tipo === 'pago')!;
    ultimo.monto = round2(ultimo.monto + ajuste);
  }
  return pagos;
}

export interface TotalMedio { moneda: Moneda; montoMoneda: number; monto: number; cantidad: number }

/** Suma de pagos por medio (vueltos restan), para caja y panel. */
export function totalesPorMedio(pagos: Pago[]): Partial<Record<MedioPago, TotalMedio>> {
  const out: Partial<Record<MedioPago, TotalMedio>> = {};
  for (const raw of pagos) {
    const p = normalizarPago(raw);
    const t = out[p.medio] ?? { moneda: p.moneda, montoMoneda: 0, monto: 0, cantidad: 0 };
    t.montoMoneda = round2(t.montoMoneda + p.montoMoneda);
    t.monto = round2(t.monto + p.monto);
    if (p.tipo === 'pago') t.cantidad++;
    out[p.medio] = t;
  }
  return out;
}
