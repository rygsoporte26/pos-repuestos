// Conversión entre los registros locales (camelCase) y las tablas de Supabase (snake_case).
import type { MedioPago, Moneda, Movimiento, Pago, Producto, SesionCaja, Venta } from '../db/types';
import { normalizarPago } from '../domain/pagos';
import { textoBusqueda } from '../domain/buscar';
import { diaLocal } from '../domain/util';

type Fila = Record<string, unknown>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const productoANube = (p: Producto): Fila => ({
  id: p.id, codigo: p.codigo, descripcion: p.descripcion, familia: p.familia, marca_aplica: p.marcaAplica,
  presentacion: p.presentacion, unidades_bulto: p.unidadesBulto, unidad_compra: p.unidadCompra, costo: p.costo,
  precio_detal: p.precioDetal, precio_mayor: p.precioMayor, cant_min_mayor: p.cantMinMayor,
  stock_minimo: p.stockMinimo, proveedor: p.proveedor ?? null, ref_proveedor: p.refProveedor ?? null, activo: p.activo,
});

export function productoDeNube(r: Fila): Producto {
  const p: Producto = {
    id: r.id as string, codigo: r.codigo as string, descripcion: r.descripcion as string,
    familia: (r.familia as string) ?? null, marcaAplica: (r.marca_aplica as string) ?? null,
    presentacion: (r.presentacion as string) ?? null, unidadesBulto: n(r.unidades_bulto),
    unidadCompra: (r.unidad_compra as string) ?? null, costo: Number(r.costo), precioDetal: n(r.precio_detal),
    precioMayor: n(r.precio_mayor), cantMinMayor: n(r.cant_min_mayor), stockMinimo: Number(r.stock_minimo ?? 0),
    proveedor: (r.proveedor as string) ?? null, refProveedor: (r.ref_proveedor as string) ?? null,
    activo: Boolean(r.activo), actualizadoEn: r.actualizado_en as string, busqueda: '',
  };
  p.busqueda = textoBusqueda(p);
  return p;
}

export const ventaANube = (v: Venta): Fila => ({
  id: v.id, numero: v.numero, sede_id: v.sedeId, dispositivo_id: v.dispositivoId, sesion_caja_id: v.sesionCajaId,
  usuario_id: v.usuarioId, creada_en: v.creadaEn, cliente_nombre: v.clienteNombre, cliente_telefono: v.clienteTelefono,
  items: v.items.map((i) => ({ id: i.id, producto_id: i.productoId, cantidad: i.cantidad, tipo_precio: i.tipoPrecio, precio_unitario: i.precioUnitario })),
  tasa: v.tasa ?? null, total_bs: v.totalBs ?? null,
  pagos: v.pagos.map(normalizarPago).map((p) => ({
    id: p.id, medio: p.medio, tipo: p.tipo, moneda: p.moneda, monto: p.monto, monto_moneda: p.montoMoneda, tasa: p.tasa, referencia: p.referencia,
  })),
});

export function ventaDeNube(r: Fila, codigos: Map<string, string>): Venta {
  const items = ((r.venta_items as Fila[]) ?? []).map((i) => ({
    id: i.id as string, productoId: i.producto_id as string, codigo: codigos.get(i.producto_id as string) ?? '',
    descripcion: i.descripcion as string, cantidad: Number(i.cantidad), tipoPrecio: i.tipo_precio as 'detal' | 'mayor',
    precioUnitario: Number(i.precio_unitario), costoUnitario: Number(i.costo_unitario), total: Number(i.total),
  }));
  const pagos: Pago[] = ((r.pagos as Fila[]) ?? []).map((p) => ({
    id: p.id as string, medio: (p.medio as MedioPago) ?? 'efectivo_usd', tipo: (p.tipo as Pago['tipo']) ?? 'pago', moneda: (p.moneda as Moneda) ?? 'USD',
    montoMoneda: Number(p.monto_moneda ?? p.monto), tasa: n(p.tasa), monto: Number(p.monto), referencia: (p.referencia as string) ?? null,
  }));
  return {
    id: r.id as string, numero: r.numero as string, sedeId: r.sede_id as string, dispositivoId: (r.dispositivo_id as string) ?? '',
    sesionCajaId: (r.sesion_caja_id as string) ?? '', usuarioId: r.usuario_id as string, usuarioNombre: (r.usuario_nombre as string) ?? '',
    clienteNombre: (r.cliente_nombre as string) ?? null, clienteTelefono: (r.cliente_telefono as string) ?? null,
    items, pagos, total: Number(r.total), tasa: n(r.tasa), totalBs: n(r.total_bs), costoTotal: Number(r.costo_total), estado: r.estado as Venta['estado'],
    creadaEn: r.creada_en as string, dia: diaLocal(new Date(r.creada_en as string)), anuladaEn: (r.anulada_en as string) ?? null,
    anuladaPor: (r.anulada_por_nombre as string) ?? null, motivoAnulacion: (r.motivo_anulacion as string) ?? null,
  };
}

export const sesionANube = (s: SesionCaja): Fila => ({
  id: s.id, sede_id: s.sedeId, dispositivo_id: s.dispositivoId, usuario_id: s.usuarioId, abierta_en: s.abiertaEn,
  efectivo_inicial: s.efectivoInicial, cerrada_en: s.cerradaEn, efectivo_contado: s.efectivoContado,
  efectivo_esperado: s.efectivoEsperado, diferencia: s.diferencia, notas: s.notas,
  efectivo_inicial_bs: s.efectivoInicialBs ?? 0, efectivo_contado_bs: s.efectivoContadoBs ?? null,
  efectivo_esperado_bs: s.efectivoEsperadoBs ?? null, diferencia_bs: s.diferenciaBs ?? null, resumen: s.resumen ?? null,
});

export const sesionDeNube = (r: Fila): SesionCaja => ({
  id: r.id as string, sedeId: r.sede_id as string, dispositivoId: (r.dispositivo_id as string) ?? '', usuarioId: r.usuario_id as string,
  usuarioNombre: (r.usuario_nombre as string) ?? '', abiertaEn: r.abierta_en as string, efectivoInicial: Number(r.efectivo_inicial),
  cerradaEn: (r.cerrada_en as string) ?? null, efectivoContado: n(r.efectivo_contado), efectivoEsperado: n(r.efectivo_esperado),
  diferencia: n(r.diferencia), notas: (r.notas as string) ?? null,
  efectivoInicialBs: Number(r.efectivo_inicial_bs ?? 0), efectivoContadoBs: n(r.efectivo_contado_bs),
  efectivoEsperadoBs: n(r.efectivo_esperado_bs), diferenciaBs: n(r.diferencia_bs), resumen: (r.resumen as SesionCaja['resumen']) ?? null,
});

export const movimientoANube = (m: Movimiento): Fila => ({
  id: m.id, sede_id: m.sedeId, producto_id: m.productoId, tipo: m.tipo, cantidad: m.cantidad, costo_unitario: m.costoUnitario,
  nota: m.nota, proveedor: m.proveedor ?? null, usuario_id: m.usuarioId, creado_en: m.creadoEn,
});

export const movimientoDeNube = (r: Fila): Movimiento => ({
  id: r.id as string, sedeId: r.sede_id as string, productoId: r.producto_id as string, tipo: r.tipo as Movimiento['tipo'],
  cantidad: Number(r.cantidad), costoUnitario: n(r.costo_unitario), referenciaId: (r.referencia_id as string) ?? null,
  nota: (r.nota as string) ?? null, proveedor: (r.proveedor as string) ?? null, usuarioId: (r.usuario_id as string) ?? '', usuarioNombre: (r.usuario_nombre as string) ?? '',
  creadoEn: r.creado_en as string,
});
