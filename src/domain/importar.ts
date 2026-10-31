import type { PosDB } from '../db/db';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { crearProducto, guardarProducto } from './productos';
import { registrarConteo } from './inventario';
import { normalizar, parseEntero, parseNum } from './util';

/** Una fila de la plantilla "Plantilla_conteo_y_precios.xlsx" ya leída. */
export interface FilaPlantilla {
  codigo: string;
  descripcion?: string;
  familia?: string;
  moto?: string;
  costo?: number | null;
  precioDetal?: number | null;
  precioMayor?: number | null;
  cantMinMayor?: number | null;
  stockContado?: number | null;
  stockMinimo?: number | null;
  nuevo?: boolean; // viene de la hoja "Nuevos productos"
}

type Celda = unknown;

const COLUMNAS: Record<string, keyof FilaPlantilla> = {
  'CODIGO': 'codigo', 'CODIGO (PROPIO)': 'codigo', 'DESCRIPCION': 'descripcion', 'FAMILIA': 'familia',
  'MARCA QUE APLICA': 'moto', 'COSTO USD (PIEZA)': 'costo', 'PRECIO DETAL USD': 'precioDetal',
  'PRECIO MAYOR USD': 'precioMayor', 'CANT. MIN. MAYOR': 'cantMinMayor', 'STOCK CONTADO (PIEZAS)': 'stockContado',
  'STOCK MINIMO (ALERTA)': 'stockMinimo',
};

/** Convierte las filas crudas de una hoja (encabezado en alguna de las primeras filas). */
export function leerHoja(filas: Celda[][], nuevo = false): FilaPlantilla[] {
  const iHead = filas.findIndex((f) => f.some((c) => typeof c === 'string' && normalizar(c).startsWith('CODIGO')));
  if (iHead < 0) return [];
  const cols = filas[iHead].map((c) => (typeof c === 'string' ? COLUMNAS[normalizar(c)] : undefined));
  const out: FilaPlantilla[] = [];
  for (const f of filas.slice(iHead + 1)) {
    const r: FilaPlantilla = { codigo: '', nuevo };
    cols.forEach((k, i) => {
      if (!k) return;
      const v = f[i];
      if (k === 'codigo' || k === 'descripcion' || k === 'familia' || k === 'moto') {
        (r as unknown as Record<string, string>)[k] = v === null || v === undefined ? '' : String(v).trim();
      } else {
        (r as unknown as Record<string, number | null>)[k] = v === null || v === undefined || v === '' ? null : parseNum(typeof v === 'number' ? v : String(v as string));
      }
    });
    if (r.codigo) out.push(r);
  }
  return out;
}

export interface PlanImportacion {
  precios: number; // productos con precios para actualizar
  conteos: number; // productos con stock contado
  nuevos: number;
  noEncontrados: string[];
  errores: { codigo: string; mensaje: string }[];
  filas: FilaPlantilla[];
}

const iguales = (a: number | null | undefined, b: number | null) => (a ?? null) === b;

export async function analizarPlantilla(d: PosDB, filas: FilaPlantilla[]): Promise<PlanImportacion> {
  const porCodigo = new Map((await d.productos.toArray()).map((p) => [p.codigo.toUpperCase(), p]));
  const plan: PlanImportacion = { precios: 0, conteos: 0, nuevos: 0, noEncontrados: [], errores: [], filas: [] };
  for (const f of filas) {
    const p = porCodigo.get(f.codigo.toUpperCase());
    if (f.nuevo) {
      if (f.descripcion?.includes('borrar esta fila')) continue;
      if (p) { plan.errores.push({ codigo: f.codigo, mensaje: 'Ya existe un producto con este código' }); continue; }
      plan.nuevos++; plan.filas.push(f); continue;
    }
    if (!p) { plan.noEncontrados.push(f.codigo); continue; }
    if (f.stockContado !== null && f.stockContado !== undefined && (!Number.isInteger(f.stockContado) || f.stockContado < 0)) {
      plan.errores.push({ codigo: f.codigo, mensaje: 'El stock contado debe ser un entero de 0 o más' }); continue;
    }
    const cambiaPrecio = f.precioDetal !== null && f.precioDetal !== undefined && (
      !iguales(f.precioDetal, p.precioDetal) || !iguales(f.precioMayor, p.precioMayor) || !iguales(f.cantMinMayor, p.cantMinMayor)
      || (f.stockMinimo !== null && f.stockMinimo !== undefined && f.stockMinimo !== p.stockMinimo));
    if (cambiaPrecio) plan.precios++;
    if (f.stockContado !== null && f.stockContado !== undefined) plan.conteos++;
    if (cambiaPrecio || (f.stockContado !== null && f.stockContado !== undefined)) plan.filas.push(f);
  }
  return plan;
}

/** Aplica el plan: precios, conteo físico y productos nuevos. Devuelve errores por fila. */
export async function aplicarPlantilla(d: PosDB, ctx: Contexto, plan: PlanImportacion, alAvanzar?: (hechas: number) => void) {
  exigir(ctx, 'editar_productos');
  exigir(ctx, 'mover_inventario');
  const porCodigo = new Map((await d.productos.toArray()).map((p) => [p.codigo.toUpperCase(), p]));
  const errores: { codigo: string; mensaje: string }[] = [];
  let i = 0;
  for (const f of plan.filas) {
    try {
      let p = porCodigo.get(f.codigo.toUpperCase());
      if (f.nuevo) {
        p = await crearProducto(d, ctx, {
          codigo: f.codigo, descripcion: f.descripcion ?? '', familia: f.familia || null, marcaAplica: f.moto || null,
          costo: f.costo ?? 0, precioDetal: f.precioDetal ?? null, precioMayor: f.precioMayor ?? null,
          cantMinMayor: f.cantMinMayor ? parseEntero(f.cantMinMayor) : null,
        });
      } else if (p && f.precioDetal !== null && f.precioDetal !== undefined) {
        await guardarProducto(d, ctx, p.id, {
          precioDetal: f.precioDetal, precioMayor: f.precioMayor ?? null, cantMinMayor: f.cantMinMayor ?? null,
          ...(f.stockMinimo !== null && f.stockMinimo !== undefined ? { stockMinimo: f.stockMinimo } : {}),
        });
      }
      if (!p) throw new ErrorNegocio('Producto no encontrado');
      if (f.stockContado !== null && f.stockContado !== undefined) await registrarConteo(d, ctx, p.id, f.stockContado, 'Conteo físico (plantilla Excel)');
    } catch (e) {
      errores.push({ codigo: f.codigo, mensaje: e instanceof Error ? e.message : String(e) });
    }
    alAvanzar?.(++i);
  }
  return errores;
}
