import type { PosDB } from '../db/db';
import type { Contexto } from './contexto';
import { medio, normalizarPago } from './pagos';

const celda = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Punto y coma + coma decimal: así Excel en español abre el archivo con columnas correctas.
const numero = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const csv = (filas: unknown[][]) => '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');

export async function csvProductos(d: PosDB, ctx: Contexto): Promise<string> {
  const stock = new Map((await d.stock.where('sedeId').equals(ctx.sedeId).toArray()).map((s) => [s.productoId, s.stock]));
  const prods = (await d.productos.toArray()).sort((a, b) => a.codigo.localeCompare(b.codigo));
  return csv([
    ['CODIGO', 'DESCRIPCION', 'FAMILIA', 'MARCA QUE APLICA', 'PRESENTACION', 'COSTO', 'PRECIO DETAL', 'PRECIO MAYOR', 'MAYOR DESDE', 'STOCK', 'STOCK MINIMO', 'ACTIVO'],
    ...prods.map((p) => [p.codigo, p.descripcion, p.familia, p.marcaAplica, p.presentacion, numero(p.costo), numero(p.precioDetal),
      numero(p.precioMayor), p.cantMinMayor, stock.get(p.id) ?? 0, p.stockMinimo, p.activo ? 'SI' : 'NO']),
  ]);
}

export async function csvVentas(d: PosDB, desde: string, hasta: string): Promise<string> {
  const ventas = (await d.ventas.where('dia').between(desde, hasta, true, true).toArray()).sort((a, b) => a.creadaEn.localeCompare(b.creadaEn));
  const filas: unknown[][] = [['FECHA', 'TICKET', 'ESTADO', 'VENDEDOR', 'CLIENTE', 'TELEFONO', 'CODIGO', 'PRODUCTO', 'CANTIDAD', 'TIPO PRECIO', 'PRECIO', 'TOTAL LINEA', 'COSTO LINEA', 'TASA', 'PAGOS', 'MOTIVO ANULACION']];
  for (const v of ventas) for (const i of v.items) {
    filas.push([new Date(v.creadaEn).toLocaleString('es-VE'), v.numero, v.estado, v.usuarioNombre, v.clienteNombre, v.clienteTelefono, i.codigo,
      i.descripcion, i.cantidad, i.tipoPrecio, numero(i.precioUnitario), numero(i.total), numero(Math.round(i.cantidad * i.costoUnitario * 100) / 100), numero(v.tasa ?? null),
      v.pagos.map(normalizarPago).map((p) => `${p.tipo === 'vuelto' ? 'vuelto ' : ''}${medio(p.medio).corto} ${p.moneda === 'VES' ? 'Bs' : '$'} ${numero(p.montoMoneda)}${p.referencia ? ` ref ${p.referencia}` : ''}`).join(' | '), v.motivoAnulacion]);
  }
  return csv(filas);
}

export function descargar(nombre: string, contenido: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
