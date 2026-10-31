import type { PosDB } from '../db/db';
import { getMeta, setMeta } from '../db/db';
import type { Canal, Producto, Venta, VentaItem } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { aplicarMovimiento, nuevoMovimiento } from './inventario';
import { totalLinea } from './precios';
import { sesionAbierta } from './caja';
import { aBs, armarPagos, type EntradaPago, type Vuelto } from './pagos';
import { encolar } from '../sync/outbox';
import { diaLocal, round2, uuid } from './util';

export interface LineaCarrito {
  producto: Producto;
  cantidad: number;
  precio?: number; // solo al mayor: precio acordado (si no, el precio mayor del producto)
}

export interface LineaCalculada extends LineaCarrito {
  tipo: 'detal' | 'mayor';
  precio: number;
  total: number;
}

/** Precio sugerido al mayor: el precio mayor del producto o, si no tiene, el detal. */
export const precioMayorSugerido = (p: Producto): number | null => p.precioMayor ?? p.precioDetal;

/**
 * Calcula precio y total de cada línea. En la tienda siempre es precio detal (el
 * vendedor no hace ventas al mayor). Al mayor se usa el precio acordado de la línea.
 */
export function calcularCarrito(lineas: LineaCarrito[], canal: Canal = 'tienda'): { lineas: LineaCalculada[]; total: number } {
  const out: LineaCalculada[] = [];
  let total = 0;
  for (const l of lineas) {
    const precio = canal === 'tienda' ? l.producto.precioDetal : (l.precio ?? precioMayorSugerido(l.producto));
    if (precio === null || precio === undefined || !(precio > 0)) throw new ErrorNegocio(`"${l.producto.descripcion}" no tiene precio`);
    const p = round2(precio);
    const t = totalLinea(l.cantidad, p);
    out.push({ ...l, tipo: canal === 'tienda' ? 'detal' : 'mayor', precio: p, total: t });
    total += t;
  }
  return { lineas: out, total: round2(total) };
}

/** Siguiente número de ticket de esta caja: S1-C1-000001. Funciona sin internet. */
async function siguienteNumero(d: PosDB, ctx: Contexto): Promise<string> {
  const clave = `contador_ticket_${ctx.dispositivoId}`;
  const n = (await getMeta<number>(d, clave, 0)) + 1;
  await setMeta(d, clave, n);
  return `${ctx.sedeCodigo}-${ctx.dispositivoCodigo}-${String(n).padStart(6, '0')}`;
}

export interface DatosCobro {
  pagos: EntradaPago[]; // uno o varios métodos (pago mixto)
  vuelto?: Vuelto; // por dónde se devuelve lo que sobra
  tasa: number | null; // tasa BCV vigente (Bs por USD)
  clienteNombre?: string;
  clienteTelefono?: string;
}

export function validarCantidades(carrito: LineaCarrito[]) {
  if (carrito.length === 0) throw new ErrorNegocio('El carrito está vacío');
  for (const l of carrito) {
    if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) throw new ErrorNegocio('Las cantidades deben ser enteros mayores que 0');
  }
}

/**
 * Guarda una venta ya calculada con su salida de inventario y la deja lista para subir.
 * Debe llamarse DENTRO de una transacción con ventas, movimientos, stock y outbox.
 */
export async function guardarVenta(
  d: PosDB, ctx: Contexto, calc: { lineas: LineaCalculada[]; total: number }, cobro: DatosCobro,
  opts: { canal: Canal; numero: string; sesionCajaId: string; dispositivoId: string; pedidoId?: string | null },
): Promise<Venta> {
  const pagos = armarPagos(calc.total, cobro.pagos, cobro.tasa, cobro.vuelto);
  const ahora = new Date();
  const id = uuid();
  const items: VentaItem[] = calc.lineas.map((l) => ({
    id: uuid(), productoId: l.producto.id, codigo: l.producto.codigo, descripcion: l.producto.descripcion,
    cantidad: l.cantidad, tipoPrecio: l.tipo, precioUnitario: l.precio, costoUnitario: l.producto.costo, total: l.total,
  }));
  const venta: Venta = {
    id, numero: opts.numero, sedeId: ctx.sedeId, dispositivoId: opts.dispositivoId,
    sesionCajaId: opts.sesionCajaId, usuarioId: ctx.usuario.id, usuarioNombre: ctx.usuario.nombre,
    clienteNombre: cobro.clienteNombre?.trim() || null, clienteTelefono: cobro.clienteTelefono?.trim() || null,
    items, pagos, total: calc.total, tasa: cobro.tasa, totalBs: cobro.tasa ? aBs(calc.total, cobro.tasa) : null,
    costoTotal: round2(items.reduce((a, i) => a + i.cantidad * i.costoUnitario, 0)),
    estado: 'completada', canal: opts.canal, pedidoId: opts.pedidoId ?? null, creadaEn: ahora.toISOString(), dia: diaLocal(ahora),
    anuladaEn: null, anuladaPor: null, motivoAnulacion: null,
  };
  await d.ventas.add(venta);
  for (const it of items) {
    // El id del movimiento es el id de la línea: la nube crea el mismo movimiento con ese id.
    await aplicarMovimiento(d, nuevoMovimiento(ctx, it.productoId, 'venta', -it.cantidad, {
      id: it.id, costoUnitario: it.costoUnitario, referenciaId: id, creadoEn: venta.creadaEn,
    }));
  }
  // En la nube, registrar_venta crea sus propios movimientos: solo se envía la venta.
  await encolar(d, 'venta', id, venta);
  return venta;
}

/**
 * Venta en la tienda (caja abierta, siempre precio detal). Se guarda completa en una sola
 * transacción: venta, salida de inventario, número de ticket y envío pendiente a la nube.
 */
export async function registrarVenta(d: PosDB, ctx: Contexto, carrito: LineaCarrito[], cobro: DatosCobro): Promise<Venta> {
  exigir(ctx, 'vender');
  validarCantidades(carrito);
  const calc = calcularCarrito(carrito, 'tienda');
  armarPagos(calc.total, cobro.pagos, cobro.tasa, cobro.vuelto); // valida antes de abrir la transacción

  return d.transaction('rw', [d.ventas, d.movimientos, d.stock, d.outbox, d.meta, d.sesiones], async () => {
    const sesion = await sesionAbierta(d, ctx.dispositivoId);
    if (!sesion) throw new ErrorNegocio('Abre la caja antes de vender');
    return guardarVenta(d, ctx, calc, cobro, {
      canal: 'tienda', numero: await siguienteNumero(d, ctx), sesionCajaId: sesion.id, dispositivoId: ctx.dispositivoId,
    });
  });
}

/** Anula una venta (solo admin): no se borra, se marca y el stock vuelve. */
export async function anularVenta(d: PosDB, ctx: Contexto, ventaId: string, motivo: string): Promise<Venta> {
  exigir(ctx, 'anular');
  if (!motivo.trim()) throw new ErrorNegocio('El motivo es obligatorio');
  return d.transaction('rw', [d.ventas, d.movimientos, d.stock, d.outbox], async () => {
    const v = await d.ventas.get(ventaId);
    if (!v) throw new ErrorNegocio('Venta no encontrada');
    if (v.estado === 'anulada') return v;
    const anulada: Venta = { ...v, estado: 'anulada', anuladaEn: new Date().toISOString(), anuladaPor: ctx.usuario.nombre, motivoAnulacion: motivo.trim() };
    await d.ventas.put(anulada);
    const movs: Record<string, string> = {};
    for (const it of v.items) {
      const m = nuevoMovimiento({ ...ctx, sedeId: v.sedeId }, it.productoId, 'anulacion', it.cantidad, {
        costoUnitario: it.costoUnitario, referenciaId: v.id, nota: motivo.trim(),
      });
      movs[it.id] = m.id;
      await aplicarMovimiento(d, m);
    }
    await encolar(d, 'anulacion', v.id, { ventaId: v.id, motivo: motivo.trim(), movs });
    return anulada;
  });
}
