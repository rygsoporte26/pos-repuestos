import type { Producto, TipoPrecio } from '../db/types';
import { round2 } from './util';

export interface PrecioAplicado {
  tipo: TipoPrecio;
  precio: number;
}

/**
 * Regla de la tienda: precio mayor cuando la cantidad de ESE producto en la venta
 * llega a su cantidad mínima mayor (definida a mano por producto). Si no tiene
 * precio mayor, siempre detal. Sin precio detal → no se puede vender (null).
 */
export function precioAplicable(
  p: Pick<Producto, 'precioDetal' | 'precioMayor' | 'cantMinMayor'>,
  cantidad: number,
): PrecioAplicado | null {
  if (p.precioDetal === null || p.precioDetal <= 0) return null;
  if (p.precioMayor !== null && p.cantMinMayor !== null && p.cantMinMayor > 0 && cantidad >= p.cantMinMayor) {
    return { tipo: 'mayor', precio: p.precioMayor };
  }
  return { tipo: 'detal', precio: p.precioDetal };
}

export const totalLinea = (cantidad: number, precio: number) => round2(cantidad * precio);

export interface ProblemaPrecio {
  campo: 'precioDetal' | 'precioMayor' | 'cantMinMayor';
  mensaje: string;
  bloquea: boolean; // true = no se puede guardar
}

/** Revisa una combinación de precios antes de guardar. */
export function revisarPrecios(p: Pick<Producto, 'costo' | 'precioDetal' | 'precioMayor' | 'cantMinMayor'>): ProblemaPrecio[] {
  const out: ProblemaPrecio[] = [];
  const { costo, precioDetal: d, precioMayor: m, cantMinMayor: q } = p;
  if (d !== null && d < 0) out.push({ campo: 'precioDetal', mensaje: 'El precio no puede ser negativo', bloquea: true });
  if (m !== null && m < 0) out.push({ campo: 'precioMayor', mensaje: 'El precio no puede ser negativo', bloquea: true });
  if ((m === null) !== (q === null))
    out.push({ campo: m === null ? 'precioMayor' : 'cantMinMayor', mensaje: 'Precio mayor y cantidad mínima van juntos', bloquea: true });
  if (q !== null && (!Number.isInteger(q) || q < 2))
    out.push({ campo: 'cantMinMayor', mensaje: 'La cantidad mínima debe ser un entero de 2 o más', bloquea: true });
  if (m !== null && d === null) out.push({ campo: 'precioDetal', mensaje: 'Falta el precio detal', bloquea: true });
  if (d !== null && m !== null && m >= d) out.push({ campo: 'precioMayor', mensaje: 'El mayor debería ser menor que el detal', bloquea: false });
  if (d !== null && d > 0 && costo > 0 && d < costo) out.push({ campo: 'precioDetal', mensaje: 'Detal por debajo del costo', bloquea: false });
  if (m !== null && costo > 0 && m < costo) out.push({ campo: 'precioMayor', mensaje: 'Mayor por debajo del costo', bloquea: false });
  return out;
}

/** % de ganancia sobre el costo (markup). */
export const ganancia = (precio: number | null, costo: number): number | null =>
  precio === null || costo <= 0 ? null : precio / costo - 1;
