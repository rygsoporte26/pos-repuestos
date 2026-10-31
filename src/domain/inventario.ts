import type { PosDB } from '../db/db';
import type { Movimiento, TipoMovimiento } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { encolar } from '../sync/outbox';
import { uuid } from './util';

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
  extra: Partial<Pick<Movimiento, 'id' | 'costoUnitario' | 'referenciaId' | 'nota' | 'creadoEn'>> = {},
): Movimiento {
  return {
    id: extra.id ?? uuid(), sedeId: ctx.sedeId, productoId, tipo, cantidad,
    costoUnitario: extra.costoUnitario ?? null, referenciaId: extra.referenciaId ?? null,
    nota: extra.nota ?? null, usuarioId: ctx.usuario.id, usuarioNombre: ctx.usuario.nombre,
    creadoEn: extra.creadoEn ?? new Date().toISOString(),
  };
}

export async function stockDe(d: PosDB, sedeId: string, productoId: string): Promise<number> {
  return (await d.stock.get(stockKey(sedeId, productoId)))?.stock ?? 0;
}

/** Entrada de mercancía (compra). Opcionalmente actualiza el costo del producto. */
export async function registrarEntrada(d: PosDB, ctx: Contexto, productoId: string, cantidad: number, opts: { costo?: number | null; nota?: string | null; actualizarCosto?: boolean } = {}) {
  exigir(ctx, 'mover_inventario');
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new ErrorNegocio('La cantidad debe ser un entero mayor que 0');
  await d.transaction('rw', [d.movimientos, d.stock, d.productos, d.outbox], async () => {
    const p = await d.productos.get(productoId);
    if (!p) throw new ErrorNegocio('Producto no encontrado');
    const m = nuevoMovimiento(ctx, productoId, 'compra', cantidad, { costoUnitario: opts.costo ?? p.costo, nota: opts.nota ?? null });
    await aplicarMovimiento(d, m);
    await encolar(d, 'movimiento', m.id, m);
    if (opts.actualizarCosto && opts.costo !== null && opts.costo !== undefined && opts.costo !== p.costo) {
      const cambio = { ...p, costo: opts.costo, actualizadoEn: new Date().toISOString() };
      await d.productos.put(cambio);
      await encolar(d, 'producto', p.id, cambio);
    }
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
