import writeXlsxFile, { type Row, type SheetData } from 'write-excel-file/universal';
import type { PosDB } from '../db/db';
import type { Contexto } from './contexto';
import { COLUMNA_STOCK_SISTEMA, COLUMNAS_PLANTILLA } from './importar';
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
    ['CODIGO', 'DESCRIPCION', 'CATEGORIA', 'MOTOS COMPATIBLES', 'PROVEEDOR', 'REF. PROVEEDOR', 'COSTO', 'PRECIO DETAL', 'PRECIO MAYOR', 'MAYOR DESDE', 'STOCK', 'STOCK MINIMO', 'ACTIVO'],
    ...prods.map((p) => [p.codigo, p.descripcion, p.familia, p.marcaAplica, p.proveedor, p.refProveedor, numero(p.costo), numero(p.precioDetal),
      numero(p.precioMayor), p.cantMinMayor, stock.get(p.id) ?? 0, p.stockMinimo, p.activo ? 'SI' : 'NO']),
  ]);
}

export async function csvVentas(d: PosDB, desde: string, hasta: string): Promise<string> {
  const ventas = (await d.ventas.where('dia').between(desde, hasta, true, true).toArray()).sort((a, b) => a.creadaEn.localeCompare(b.creadaEn));
  const filas: unknown[][] = [['FECHA', 'TICKET', 'CANAL', 'ESTADO', 'VENDEDOR', 'CLIENTE', 'TELEFONO', 'CODIGO', 'PRODUCTO', 'CANTIDAD', 'TIPO PRECIO', 'PRECIO', 'TOTAL LINEA', 'COSTO LINEA', 'DESCUENTO VENTA', 'TOTAL VENTA', 'TASA', 'PAGOS', 'MOTIVO ANULACION']];
  for (const v of ventas) for (const i of v.items) {
    filas.push([new Date(v.creadaEn).toLocaleString('es-VE'), v.numero, v.canal === 'mayor' ? 'MAYOR' : 'TIENDA', v.estado, v.usuarioNombre, v.clienteNombre, v.clienteTelefono, i.codigo,
      i.descripcion, i.cantidad, i.tipoPrecio, numero(i.precioUnitario), numero(i.total), numero(Math.round(i.cantidad * i.costoUnitario * 100) / 100), numero(v.descuento ?? 0), numero(v.total), numero(v.tasa ?? null),
      v.pagos.map(normalizarPago).map((p) => `${p.tipo === 'vuelto' ? 'vuelto ' : ''}${medio(p.medio).corto} ${p.moneda === 'VES' ? 'Bs' : '$'} ${numero(p.montoMoneda)}${p.referencia ? ` ref ${p.referencia}` : ''}`).join(' | '), v.motivoAnulacion]);
  }
  return csv(filas);
}

const ENCABEZADO = { fontWeight: 'bold', backgroundColor: '#1F2933', textColor: '#FFFFFF', wrap: true, alignVertical: 'center' } as const;

export const INSTRUCCIONES_PLANTILLA = [
  'CÓMO LLENAR LA PLANTILLA DEL CATÁLOGO',
  '',
  '1. Una fila por producto, en la hoja "Catalogo". No cambies los títulos de las columnas.',
  '2. CODIGO: código propio de la tienda (ej. RYG0001). Si lo dejas vacío, el POS asigna el siguiente libre.',
  '   Si vas a pegar etiquetas mientras cuentas, escribe tú el código. No se repite y no lleva espacios.',
  '3. DESCRIPCION es lo único obligatorio. Incluye marca y medida si sirve para distinguirlo (ej. PASTILLA FRENO DEL. DISCO).',
  '4. MOTOS COMPATIBLES: separadas por coma (ej. BERA SBR, EMPIRE HORSE 150, JAGUAR). Sirven para buscar al vender.',
  '5. PROVEEDOR y REF. PROVEEDOR: a quién se le compra y su código. Opcional, ayuda a reponer.',
  '6. Precios y costo en dólares por PIEZA. Usa coma o punto para decimales.',
  '7. Precio mayor: se aplica cuando el cliente lleva la CANT. MIN. MAYOR o más. Van los dos juntos o ninguno.',
  '8. STOCK CONTADO: las piezas que hay en la tienda HOY. REEMPLAZA el stock del sistema por ese número.',
  '   Déjalo vacío si no contaste ese producto. Para mercancía que llega después usa Inventario → Entrada de mercancía.',
  '9. STOCK MINIMO: con cuántas piezas o menos avisa "stock bajo".',
  '10. Se importa en el POS: Ajustes → Importar catálogo desde Excel. Antes de aplicar muestra el resumen y los errores.',
  '',
  'Celda vacía = no cambia nada. Así puedes volver a subir esta hoja más adelante solo para cambiar precios.',
];

/**
 * Catálogo en Excel con el mismo formato de la plantilla, listo para editar y volver a importar.
 * STOCK CONTADO sale vacío a propósito (si se llena, reemplaza el stock); el stock de hoy va
 * en una columna aparte que la importación ignora. Con `vacia` solo trae los títulos.
 */
export async function xlsxCatalogo(d: PosDB, ctx: Contexto, vacia = false): Promise<Blob> {
  const stock = new Map((await d.stock.where('sedeId').equals(ctx.sedeId).toArray()).map((s) => [s.productoId, s.stock]));
  const prods = vacia ? [] : (await d.productos.toArray()).filter((p) => p.activo).sort((a, b) => a.codigo.localeCompare(b.codigo));
  const cols = [...COLUMNAS_PLANTILLA, ...(vacia ? [] : [{ titulo: COLUMNA_STOCK_SISTEMA, campo: null, ancho: 14, numero: true }])];
  const valor = (p: (typeof prods)[number], campo: string | null): string | number | null => {
    switch (campo) {
      case 'codigo': return p.codigo;
      case 'descripcion': return p.descripcion;
      case 'familia': return p.familia;
      case 'moto': return p.marcaAplica;
      case 'proveedor': return p.proveedor ?? null;
      case 'refProveedor': return p.refProveedor ?? null;
      case 'costo': return p.costo || null;
      case 'precioDetal': return p.precioDetal;
      case 'precioMayor': return p.precioMayor;
      case 'cantMinMayor': return p.cantMinMayor;
      case 'stockContado': return null;
      case 'stockMinimo': return p.stockMinimo;
      default: return stock.get(p.id) ?? 0;
    }
  };
  const datos: SheetData = [
    cols.map((c) => ({ value: c.titulo, ...ENCABEZADO, ...(c.campo === null ? { backgroundColor: '#6B7280' } : {}) })),
    ...prods.map((p): Row => cols.map((c) => {
      const v = valor(p, c.campo);
      if (v === null || v === undefined) return null;
      return typeof v === 'number' ? { value: v, type: Number, format: c.campo === 'costo' || c.campo?.startsWith('precio') ? '0.00' : '0' } : { value: v, type: String };
    })),
  ];
  return writeXlsxFile([
    { data: datos, sheet: 'Catalogo', columns: cols.map((c) => ({ width: c.ancho })), stickyRowsCount: 1 },
    { data: INSTRUCCIONES_PLANTILLA.map((t, i) => [{ value: t, ...(i === 0 ? { fontWeight: 'bold' as const } : {}) }]), sheet: 'Instrucciones', columns: [{ width: 110 }] },
  ]).toBlob();
}

export function descargarArchivo(nombre: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function descargar(nombre: string, contenido: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
