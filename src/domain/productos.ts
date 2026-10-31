import type { PosDB } from '../db/db';
import { getMeta } from '../db/db';
import type { Negocio, Producto } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { revisarPrecios } from './precios';
import { textoBusqueda } from './buscar';
import { encolar } from '../sync/outbox';
import { normalizar, round2, uuid } from './util';

export type CambiosProducto = Partial<Pick<Producto,
  'descripcion' | 'familia' | 'marcaAplica' | 'costo' | 'precioDetal' | 'precioMayor' | 'cantMinMayor' | 'stockMinimo' | 'activo'
  | 'proveedor' | 'refProveedor'>>;

export const PREFIJO_POR_DEFECTO = 'RYG';
const texto = (v: string | null | undefined) => (v && v.trim() ? normalizar(v) : null);

export async function prefijoCodigo(d: PosDB): Promise<string> {
  const n = await getMeta<Negocio | null>(d, 'negocio', null);
  return (n?.prefijoCodigo || PREFIJO_POR_DEFECTO).trim().toUpperCase();
}

/** Siguiente código propio libre: RYG0001, RYG0002… (sigue después del número más alto). */
export function siguienteDe(codigos: Iterable<string>, prefijo: string, ancho = 4): string {
  const re = new RegExp(`^${prefijo.replace(/[^A-Z0-9]/g, '')}(\\d+)$`);
  let max = 0;
  for (const c of codigos) { const m = re.exec(c.toUpperCase()); if (m) max = Math.max(max, Number(m[1])); }
  return prefijo + String(max + 1).padStart(ancho, '0');
}

export async function siguienteCodigo(d: PosDB): Promise<string> {
  const prefijo = await prefijoCodigo(d);
  const codigos = (await d.productos.where('codigo').startsWith(prefijo).toArray()).map((p) => p.codigo);
  return siguienteDe(codigos, prefijo);
}

const r2 = (n: number | null | undefined) => (n === null || n === undefined ? n : round2(n));

/** Guarda cambios de un producto validando precios. Devuelve avisos no bloqueantes. */
export async function guardarProducto(d: PosDB, ctx: Contexto, id: string, cambios: CambiosProducto): Promise<string[]> {
  exigir(ctx, 'editar_productos');
  return d.transaction('rw', [d.productos, d.outbox], async () => {
    const p = await d.productos.get(id);
    if (!p) throw new ErrorNegocio('Producto no encontrado');
    const nuevo: Producto = {
      ...p, ...cambios,
      costo: r2(cambios.costo ?? p.costo) as number,
      precioDetal: cambios.precioDetal === undefined ? p.precioDetal : (r2(cambios.precioDetal) as number | null),
      precioMayor: cambios.precioMayor === undefined ? p.precioMayor : (r2(cambios.precioMayor) as number | null),
      ...(cambios.descripcion !== undefined ? { descripcion: normalizar(cambios.descripcion) } : {}),
      ...(cambios.familia !== undefined ? { familia: texto(cambios.familia) } : {}),
      ...(cambios.marcaAplica !== undefined ? { marcaAplica: texto(cambios.marcaAplica) } : {}),
      ...(cambios.proveedor !== undefined ? { proveedor: texto(cambios.proveedor) } : {}),
      ...(cambios.refProveedor !== undefined ? { refProveedor: cambios.refProveedor?.trim() || null } : {}),
      actualizadoEn: new Date().toISOString(),
    };
    if (!nuevo.descripcion) throw new ErrorNegocio('La descripción es obligatoria');
    if (nuevo.stockMinimo < 0 || !Number.isInteger(nuevo.stockMinimo)) throw new ErrorNegocio('El stock mínimo debe ser un entero de 0 o más');
    const problemas = revisarPrecios(nuevo);
    const bloqueante = problemas.find((x) => x.bloquea);
    if (bloqueante) throw new ErrorNegocio(bloqueante.mensaje);
    nuevo.busqueda = textoBusqueda(nuevo);
    await d.productos.put(nuevo);
    await encolar(d, 'producto', id, nuevo);
    return problemas.map((x) => x.mensaje);
  });
}

export interface NuevoProducto {
  codigo: string; // vacío = siguiente código propio (RYG0001…)
  descripcion: string;
  familia: string | null;
  marcaAplica: string | null;
  costo: number;
  precioDetal: number | null;
  precioMayor: number | null;
  cantMinMayor: number | null;
  stockMinimo?: number | null;
  proveedor?: string | null;
  refProveedor?: string | null;
}

export async function crearProducto(d: PosDB, ctx: Contexto, n: NuevoProducto): Promise<Producto> {
  exigir(ctx, 'editar_productos');
  const codigo = n.codigo.trim().toUpperCase() || (await siguienteCodigo(d));
  if (/\s/.test(codigo)) throw new ErrorNegocio('El código no puede tener espacios');
  if (!n.descripcion.trim()) throw new ErrorNegocio('La descripción es obligatoria');
  const stockMinimo = n.stockMinimo ?? 0;
  if (!Number.isInteger(stockMinimo) || stockMinimo < 0) throw new ErrorNegocio('El stock mínimo debe ser un entero de 0 o más');
  const p: Producto = {
    id: uuid(), codigo, descripcion: normalizar(n.descripcion), familia: texto(n.familia),
    marcaAplica: texto(n.marcaAplica), presentacion: null, unidadesBulto: null,
    unidadCompra: 'PIEZA', costo: round2(n.costo), precioDetal: r2(n.precioDetal) ?? null, precioMayor: r2(n.precioMayor) ?? null,
    cantMinMayor: n.cantMinMayor, stockMinimo, proveedor: texto(n.proveedor), refProveedor: n.refProveedor?.trim() || null,
    activo: true, actualizadoEn: new Date().toISOString(), busqueda: '',
  };
  const bloq = revisarPrecios(p).find((x) => x.bloquea);
  if (bloq) throw new ErrorNegocio(bloq.mensaje);
  p.busqueda = textoBusqueda(p);
  return d.transaction('rw', [d.productos, d.outbox], async () => {
    if (await d.productos.where('codigo').equals(codigo).count()) throw new ErrorNegocio(`Ya existe un producto con código ${codigo}`);
    await d.productos.add(p);
    await encolar(d, 'producto', p.id, p);
    return p;
  });
}
