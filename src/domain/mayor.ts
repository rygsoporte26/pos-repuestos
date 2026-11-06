// Ventas al mayor: las gestionan el administrador o el supervisor, fuera de la caja.
//
// Flujo: un cliente mayorista pide → se registra el PEDIDO (aparta las piezas: la tienda deja
// de verlas como disponibles) → llega la mercancía (Entrada de mercancía, como siempre) →
// se DESPACHA el pedido: se cobra completo y queda como venta al mayor (sale del inventario).
// También se puede vender al mayor directo, sin apartar antes.
import type { PosDB } from '../db/db';
import { getMeta, setMeta } from '../db/db';
import type { ItemPedido, PedidoMayor, Producto, Venta } from '../db/types';
import { ErrorNegocio, exigir, puede, type Contexto } from './contexto';
import { calcularCarrito, guardarVenta, validarCantidades, type DatosCobro, type LineaCarrito } from './ventas';
import { encolar } from '../sync/outbox';
import { round2, uuid } from './util';

/** Prefijo de los números al mayor de este equipo: S1-MC1- (el supervisor usa S1-MSV-). */
export const prefijoMayor = (ctx: Contexto) =>
  `${ctx.sedeCodigo}-M${puede(ctx.usuario.rol, 'caja') ? ctx.dispositivoCodigo : 'SV'}-`;
export const claveContadorMayor = (ctx: Contexto) => `contador_mayor_${ctx.sedeId}_${ctx.dispositivoId}`;

async function siguienteNumeroMayor(d: PosDB, ctx: Contexto): Promise<string> {
  const clave = claveContadorMayor(ctx);
  const n = (await getMeta<number>(d, clave, 0)) + 1;
  await setMeta(d, clave, n);
  return prefijoMayor(ctx) + String(n).padStart(6, '0');
}

/** Piezas apartadas por pedidos pendientes, por producto, en una sede. */
export async function apartados(d: PosDB, sedeId: string, excepto?: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const pend = await d.pedidos.where('estado').equals('pendiente').filter((p) => p.sedeId === sedeId && p.id !== excepto).toArray();
  for (const p of pend) for (const i of p.items) m.set(i.productoId, (m.get(i.productoId) ?? 0) + i.cantidad);
  return m;
}

export interface DatosPedido {
  clienteNombre: string;
  clienteTelefono?: string | null;
  nota?: string | null;
  lineas: LineaCarrito[]; // con precio acordado (si falta, el precio mayor del producto)
}

function armarItems(datos: DatosPedido): { items: ItemPedido[]; total: number; lineas: LineaCarrito[] } {
  if (!datos.clienteNombre.trim()) throw new ErrorNegocio('El nombre del cliente es obligatorio en ventas al mayor');
  validarCantidades(datos.lineas);
  const ids = new Set<string>();
  for (const l of datos.lineas) {
    if (ids.has(l.producto.id)) throw new ErrorNegocio(`"${l.producto.descripcion}" está repetido en el pedido`);
    ids.add(l.producto.id);
  }
  const calc = calcularCarrito(datos.lineas, 'mayor');
  const items = calc.lineas.map((l) => ({ productoId: l.producto.id, codigo: l.producto.codigo, descripcion: l.producto.descripcion, cantidad: l.cantidad, precio: l.precio }));
  return { items, total: calc.total, lineas: calc.lineas.map((l) => ({ producto: l.producto, cantidad: l.cantidad, precio: l.precio })) };
}

/** Crea o modifica un pedido pendiente (aparta las piezas). */
export async function guardarPedido(d: PosDB, ctx: Contexto, datos: DatosPedido, id?: string): Promise<PedidoMayor> {
  exigir(ctx, 'mayor');
  const { items, total } = armarItems(datos);
  return d.transaction('rw', [d.pedidos, d.outbox, d.meta], async () => {
    const ahora = new Date().toISOString();
    const previo = id ? await d.pedidos.get(id) : undefined;
    if (id && !previo) throw new ErrorNegocio('Pedido no encontrado');
    if (previo && previo.estado !== 'pendiente') throw new ErrorNegocio('Solo se puede modificar un pedido pendiente');
    const pedido: PedidoMayor = {
      id: previo?.id ?? uuid(), numero: previo?.numero ?? (await siguienteNumeroMayor(d, ctx)), sedeId: previo?.sedeId ?? ctx.sedeId,
      clienteNombre: datos.clienteNombre.trim(), clienteTelefono: datos.clienteTelefono?.trim() || null, nota: datos.nota?.trim() || null,
      items, total, estado: 'pendiente', ventaId: null, motivoCancelacion: null,
      creadoEn: previo?.creadoEn ?? ahora, creadoPor: previo?.creadoPor ?? ctx.usuario.nombre, actualizadoEn: ahora,
    };
    await d.pedidos.put(pedido);
    await encolar(d, 'pedido', pedido.id, pedido);
    return pedido;
  });
}

/** Cancela un pedido pendiente: las piezas vuelven a estar disponibles para la tienda. */
export async function cancelarPedido(d: PosDB, ctx: Contexto, id: string, motivo: string): Promise<PedidoMayor> {
  exigir(ctx, 'mayor');
  if (!motivo.trim()) throw new ErrorNegocio('El motivo es obligatorio');
  return d.transaction('rw', [d.pedidos, d.outbox], async () => {
    const p = await d.pedidos.get(id);
    if (!p) throw new ErrorNegocio('Pedido no encontrado');
    if (p.estado !== 'pendiente') throw new ErrorNegocio('Solo se puede cancelar un pedido pendiente');
    const cancelado: PedidoMayor = { ...p, estado: 'cancelado', motivoCancelacion: motivo.trim(), actualizadoEn: new Date().toISOString() };
    await d.pedidos.put(cancelado);
    await encolar(d, 'pedido', id, cancelado);
    return cancelado;
  });
}

/**
 * Venta al mayor: se cobra completa y sale del inventario en ese momento. Si viene de un
 * pedido apartado, el pedido queda despachado con el mismo número.
 */
export async function venderMayor(
  d: PosDB, ctx: Contexto, datos: DatosPedido, cobro: Omit<DatosCobro, 'clienteNombre' | 'clienteTelefono'>, pedidoId?: string,
): Promise<Venta> {
  exigir(ctx, 'mayor');
  const { items, total, lineas } = armarItems(datos);
  const calc = calcularCarrito(lineas, 'mayor');
  return d.transaction('rw', [d.pedidos, d.ventas, d.movimientos, d.stock, d.outbox, d.meta], async () => {
    const pedido = pedidoId ? await d.pedidos.get(pedidoId) : undefined;
    if (pedidoId && !pedido) throw new ErrorNegocio('Pedido no encontrado');
    if (pedido && pedido.estado !== 'pendiente') throw new ErrorNegocio(`El pedido ${pedido.numero} ya está ${pedido.estado}`);
    if (pedido && pedido.sedeId !== ctx.sedeId) throw new ErrorNegocio('El pedido es de otra sede');
    const datosCobro: DatosCobro = { ...cobro, clienteNombre: datos.clienteNombre, clienteTelefono: datos.clienteTelefono ?? undefined };
    const venta = await guardarVenta(d, ctx, calc, datosCobro, {
      canal: 'mayor', numero: pedido?.numero ?? (await siguienteNumeroMayor(d, ctx)), sesionCajaId: '', dispositivoId: '', pedidoId: pedido?.id ?? null,
    });
    if (pedido) {
      const despachado: PedidoMayor = {
        ...pedido, items, total: round2(total), clienteNombre: datos.clienteNombre.trim(), clienteTelefono: datos.clienteTelefono?.trim() || null,
        estado: 'despachado', ventaId: venta.id, actualizadoEn: new Date().toISOString(),
      };
      await d.pedidos.put(despachado);
      await encolar(d, 'pedido', pedido.id, despachado);
    }
    return venta;
  });
}

/** Líneas editables a partir de un pedido guardado (para modificarlo o despacharlo). */
export function lineasDePedido(p: PedidoMayor, productos: Map<string, Producto>): LineaCarrito[] {
  return p.items.map((i) => {
    const producto = productos.get(i.productoId);
    if (!producto) throw new ErrorNegocio(`El producto ${i.codigo} ya no existe`);
    return { producto, cantidad: i.cantidad, precio: i.precio };
  });
}
