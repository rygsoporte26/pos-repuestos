import type { Producto } from '../db/types';
import { normalizar } from './util';

export const textoBusqueda = (p: Pick<Producto, 'codigo' | 'descripcion' | 'familia' | 'marcaAplica' | 'proveedor' | 'refProveedor'>): string =>
  normalizar([p.codigo, p.descripcion, p.familia ?? '', p.marcaAplica ?? '', p.proveedor ?? '', p.refProveedor ?? ''].join(' '));

/**
 * Busca por código, descripción, categoría, moto, proveedor o referencia del proveedor. Todas las palabras deben aparecer
 * ("pastilla jaguar"). Código exacto primero, luego códigos que empiezan igual.
 */
export function buscarProductos(lista: Producto[], consulta: string, limite = 40): Producto[] {
  const q = normalizar(consulta);
  if (!q) return [];
  const palabras = q.split(' ');
  const exacto: Producto[] = [];
  const prefijo: Producto[] = [];
  const resto: Producto[] = [];
  for (const p of lista) {
    if (!p.activo) continue;
    const cod = p.codigo.toUpperCase();
    if (cod === q) exacto.push(p);
    else if (palabras.length === 1 && cod.startsWith(q)) prefijo.push(p);
    else if (palabras.every((w) => p.busqueda.includes(w))) resto.push(p);
  }
  resto.sort((a, b) => a.descripcion.localeCompare(b.descripcion));
  return [...exacto, ...prefijo, ...resto].slice(0, limite);
}
