import type { PosDB } from '../db/db';
import type { Movimiento, Producto, TipoMovimiento } from '../db/types';
import { textoBusqueda } from './buscar';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { encolar } from '../sync/outbox';
import { normalizar, round2, uuid } from './util';

export const stockKey = (sedeId: string, productoId: string) => `${sedeId}|${productoId}`;

/**
 * Inserta un movimiento y actualiza el stock en caché. Debe llamarse DENTRO de una
 * transacción que incluya movimientos y stock. El stock oficial es la suma de
 * movimientos; la tabla stock es solo para leer rápido (ver recalcularStock).
 */
export async function aplicarMovimiento(d: PosDB, m: Movimiento) {
  await d.movimientos.add(m);
  const key = stockKey(m.sedeId, m.productoId);
  const actual = await d.stock.get(key);
  await d.stock.put({ key, sedeId: m.sedeId, productoId: m.productoId, stock: (actual?.stock ?? 0) + m.cantidad });
}

export function nuevoMovimiento(
  ctx: Contexto, productoId: string, tipo: TipoMovimiento, cantidad: number,
  extra: Partial<Pick<Movimiento, 'id' | 'costoUnitario' | 'referenciaId' | 'nota' | 'proveedor' | 'creadoEn'>> = {},
): Movimiento {
  return {
    id: extra.id ?? uuid(), sedeId: ctx.sedeId, productoId, tipo, cantidad,
    costoUnitario: extra.costoUnitario ?? null, referenciaId: extra.referenciaId ?? null,
    nota: extra.nota ?? null, proveedor: extra.proveedor ?? null, usuarioId: ctx.usuario.id, usuarioNombre: ctx.usuario.nombre,
    creadoEn: extra.creadoEn ?? new Date().toISOString(),
  };
}

export async function stockDe(d: PosDB, sedeId: string, productoId: string): Promise<number> {
  return (await d.stock.get(stockKey(sedeId, productoId)))?.stock ?? 0;
}

/**
 * Entrada de mercancía (compra). Opcionalmente actualiza el costo del producto.
 * Si se indica el proveedor, queda en el movimiento y como proveedor del producto.
 */
export async function registrarEntrada(d: PosDB, ctx: Contexto, productoId: string, cantidad: number, opts: { costo?: number | null; nota?: string | null; proveedor?: string | null; actualizarCosto?: boolean } = {}): Promise<Movimiento> {
  exigir(ctx, 'mover_inventario');
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new ErrorNegocio('La cantidad debe ser un entero mayor que 0');
  return d.transaction('rw', [d.movimientos, d.stock, d.productos, d.outbox], async () => {
    const p = await d.productos.get(productoId);
    if (!p) throw new ErrorNegocio('Producto no encontrado');
    if (opts.costo !== null && opts.costo !== undefined && (!Number.isFinite(opts.costo) || opts.costo < 0)) throw new ErrorNegocio('El costo no puede ser negativo');
    const proveedor = opts.proveedor?.trim() ? normalizar(opts.proveedor) : null;
    const m = nuevoMovimiento(ctx, productoId, 'compra', cantidad, { costoUnitario: opts.costo ?? p.costo, nota: opts.nota?.trim() || null, proveedor });
    await aplicarMovimiento(d, m);
    await encolar(d, 'movimiento', m.id, m);
    const cambiaCosto = opts.actualizarCosto && opts.costo !== null && opts.costo !== undefined && round2(opts.costo) !== p.costo;
    const cambiaProv = proveedor !== null && proveedor !== (p.proveedor ?? null);
    if (cambiaCosto || cambiaProv) {
      const cambio: Producto = { ...p, actualizadoEn: new Date().toISOString() };
      if (cambiaCosto) cambio.costo = round2(opts.costo!);
      if (cambiaProv) cambio.proveedor = proveedor;
      cambio.busqueda = textoBusqueda(cambio);
      await d.productos.put(cambio);
      await encolar(d, 'producto', p.id, cambio);
    }
    return m;
  });
}

/**
 * Conteo físico: el usuario dice cuántas piezas hay. Si el producto nunca tuvo
 * movimientos en esta sede se registra como 'inicial'; si no, como 'ajuste' por la
 * diferencia. Devuelve la diferencia aplicada (0 = no cambió nada).
 */
export async function registrarConteo(d: PosDB, ctx: Contexto, productoId: string, contado: number, nota?: string): Promise<number> {
  exigir(ctx, 'mover_inventario');
  if (!Number.isInteger(contado) || contado < 0) throw new ErrorNegocio('El conteo debe ser un entero de 0 o más');
  return d.transaction('rw', [d.movimientos, d.stock, d.outbox], async () => {
    const actual = await stockDe(d, ctx.sedeId, productoId);
    const tiene = (await d.movimientos.where('productoId').equals(productoId).filter((m) => m.sedeId === ctx.sedeId).count()) > 0;
    const diff = contado - actual;
    if (diff === 0) return 0; // coincide (o conteo 0 sin historia): nada que registrar
    const m = nuevoMovimiento(ctx, productoId, tiene ? 'ajuste' : 'inicial', diff, { nota: nota || (tiene ? 'Conteo físico' : 'Inventario inicial') });
    await aplicarMovimiento(d, m);
    await encolar(d, 'movimiento', m.id, m);
    return diff;
  });
}

/** Reconstruye la caché de stock desde los movimientos (por si algo se desincroniza). */
export async function recalcularStock(d: PosDB) {
  await d.transaction('rw', [d.movimientos, d.stock], async () => {
    const tot = new Map<string, { sedeId: string; productoId: string; stock: number }>();
    await d.movimientos.each((m) => {
      const k = stockKey(m.sedeId, m.productoId);
      const t = tot.get(k) ?? { sedeId: m.sedeId, productoId: m.productoId, stock: 0 };
      t.stock += m.cantidad;
      tot.set(k, t);
    });
    await d.stock.clear();
    await d.stock.bulkPut([...tot.entries()].map(([key, v]) => ({ key, ...v })));
  });
}
