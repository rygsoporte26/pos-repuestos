import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Producto, Tasa } from '../db/types';
import { leerTasa } from '../domain/tasa';

const VACIO: Producto[] = [];

/** Catálogo completo en memoria (1.2k productos: cabe sin problema). */
export function useProductos(): Producto[] {
  return useLiveQuery(() => db.productos.toArray(), [], VACIO) ?? VACIO;
}

/** Stock por producto de una sede: Map productoId → piezas. */
export function useStock(sedeId: string): Map<string, number> {
  const filas = useLiveQuery(() => db.stock.where('sedeId').equals(sedeId).toArray(), [sedeId]);
  const m = new Map<string, number>();
  for (const s of filas ?? []) m.set(s.productoId, s.stock);
  return m;
}

export const claseStock = (stock: number, minimo: number) =>
  stock < 0 ? 'stock-neg' : minimo > 0 && stock <= minimo ? 'stock-low' : '';

/** Tasa BCV vigente en este equipo (undefined mientras carga). */
export function useTasa(): Tasa | null | undefined {
  return useLiveQuery(() => leerTasa(db), []);
}
