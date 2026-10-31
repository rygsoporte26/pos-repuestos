import type { PosDB } from '../db/db';
import type { Producto } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { revisarPrecios } from './precios';
import { textoBusqueda } from './buscar';
import { encolar } from '../sync/outbox';
import { normalizar, round2, uuid } from './util';

export type CambiosProducto = Partial<Pick<Producto,
  'descripcion' | 'familia' | 'marcaAplica' | 'costo' | 'precioDetal' | 'precioMayor' | 'cantMinMayor' | 'stockMinimo' | 'activo'>>;

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
      actualizadoEn: new Date().toISOString(),
    };
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
  codigo: string;
  descripcion: string;
  familia: string | null;
  marcaAplica: string | null;
  costo: number;
  precioDetal: number | null;
  precioMayor: number | null;
  cantMinMayor: number | null;
}

export async function crearProducto(d: PosDB, ctx: Contexto, n: NuevoProducto): Promise<Producto> {
  exigir(ctx, 'editar_productos');
  const codigo = n.codigo.trim().toUpperCase();
  if (!codigo) throw new ErrorNegocio('El código es obligatorio');
  if (!n.descripcion.trim()) throw new ErrorNegocio('La descripción es obligatoria');
  const p: Producto = {
    id: uuid(), codigo, descripcion: normalizar(n.descripcion), familia: n.familia ? normalizar(n.familia) : null,
    marcaAplica: n.marcaAplica ? normalizar(n.marcaAplica) : null, presentacion: null, unidadesBulto: null,
    unidadCompra: 'PIEZA', costo: round2(n.costo), precioDetal: r2(n.precioDetal) ?? null, precioMayor: r2(n.precioMayor) ?? null,
    cantMinMayor: n.cantMinMayor, stockMinimo: 0, activo: true, actualizadoEn: new Date().toISOString(), busqueda: '',
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
