import type { PosDB } from '../db/db';
import type { Producto } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { crearProducto, guardarProducto, prefijoCodigo, siguienteDe, type CambiosProducto } from './productos';
import { registrarConteo } from './inventario';
import { revisarPrecios } from './precios';
import { normalizar, parseNum } from './util';

/**
 * Plantilla del catálogo ("Plantilla_catalogo_inicial.xlsx", hoja "Catalogo").
 * Una fila por producto. La misma hoja sirve para crear el catálogo con su stock
 * inicial y, más adelante, para cambiar precios o datos en bloque.
 */
export type CampoPlantilla =
  | 'codigo' | 'descripcion' | 'familia' | 'moto' | 'proveedor' | 'refProveedor'
  | 'costo' | 'precioDetal' | 'precioMayor' | 'cantMinMayor' | 'stockContado' | 'stockMinimo';

export const COLUMNAS_PLANTILLA: { titulo: string; campo: CampoPlantilla; ancho: number; numero?: boolean }[] = [
  { titulo: 'CODIGO', campo: 'codigo', ancho: 12 },
  { titulo: 'DESCRIPCION', campo: 'descripcion', ancho: 42 },
  { titulo: 'CATEGORIA', campo: 'familia', ancho: 18 },
  { titulo: 'MOTOS COMPATIBLES', campo: 'moto', ancho: 28 },
  { titulo: 'PROVEEDOR', campo: 'proveedor', ancho: 18 },
  { titulo: 'REF. PROVEEDOR', campo: 'refProveedor', ancho: 15 },
  { titulo: 'COSTO USD (PIEZA)', campo: 'costo', ancho: 11, numero: true },
  { titulo: 'PRECIO DETAL USD', campo: 'precioDetal', ancho: 11, numero: true },
  { titulo: 'PRECIO MAYOR USD', campo: 'precioMayor', ancho: 11, numero: true },
  { titulo: 'CANT. MIN. MAYOR', campo: 'cantMinMayor', ancho: 10, numero: true },
  { titulo: 'STOCK CONTADO (PIEZAS)', campo: 'stockContado', ancho: 12, numero: true },
  { titulo: 'STOCK MINIMO (ALERTA)', campo: 'stockMinimo', ancho: 11, numero: true },
];
/** Columna informativa que agrega la descarga del catálogo; al importar se ignora. */
export const COLUMNA_STOCK_SISTEMA = 'STOCK EN SISTEMA (NO SE IMPORTA)';

// Nombres alternativos (plantilla anterior) que también se aceptan.
const ALIAS: Record<string, CampoPlantilla> = {
  'CODIGO (PROPIO)': 'codigo', 'FAMILIA': 'familia', 'MARCA QUE APLICA': 'moto', 'MOTO': 'moto', 'MOTOS': 'moto',
  'REFERENCIA PROVEEDOR': 'refProveedor', 'COSTO': 'costo', 'PRECIO DETAL': 'precioDetal', 'PRECIO MAYOR': 'precioMayor',
  'MAYOR DESDE': 'cantMinMayor', 'STOCK CONTADO': 'stockContado', 'STOCK MINIMO': 'stockMinimo',
};
const MAPA: Record<string, CampoPlantilla> = {
  ...ALIAS, ...Object.fromEntries(COLUMNAS_PLANTILLA.map((c) => [normalizar(c.titulo), c.campo])),
};
const NUMERICOS = new Set(COLUMNAS_PLANTILLA.filter((c) => c.numero).map((c) => c.campo));

/** Una fila de la plantilla ya leída. Celda vacía = undefined (no cambia nada). */
export interface FilaPlantilla {
  fila: number; // número de fila en Excel, para los mensajes
  codigo: string;
  descripcion?: string;
  familia?: string;
  moto?: string;
  proveedor?: string;
  refProveedor?: string;
  costo?: number;
  precioDetal?: number;
  precioMayor?: number;
  cantMinMayor?: number;
  stockContado?: number;
  stockMinimo?: number;
  invalidos: string[]; // columnas con un número que no se entiende ("cinco", "5$")
}

type Celda = unknown;

/** Convierte las filas crudas de una hoja (el encabezado puede estar en cualquiera de las primeras filas). */
export function leerHoja(filas: Celda[][]): FilaPlantilla[] {
  const esTitulo = (c: Celda) => typeof c === 'string' && ['CODIGO', 'DESCRIPCION'].includes(normalizar(c).split(' ')[0]);
  const iHead = filas.findIndex((f) => f.filter(esTitulo).length >= 2);
  if (iHead < 0) throw new ErrorNegocio('No se encontró el encabezado (columnas CODIGO y DESCRIPCION)');
  const cols = filas[iHead].map((c) => (typeof c === 'string' ? MAPA[normalizar(c)] : undefined));
  if (!cols.includes('descripcion')) throw new ErrorNegocio('Falta la columna DESCRIPCION');
  const out: FilaPlantilla[] = [];
  filas.slice(iHead + 1).forEach((f, i) => {
    const r: FilaPlantilla = { fila: iHead + i + 2, codigo: '', invalidos: [] };
    const datos = r as unknown as Record<string, string | number | undefined>;
    cols.forEach((k, j) => {
      if (!k) return;
      const v = f[j];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return;
      if (NUMERICOS.has(k)) {
        const n = parseNum(typeof v === 'number' ? v : String(v).replace(/\$|USD/gi, ''));
        if (n === null) r.invalidos.push(COLUMNAS_PLANTILLA.find((c) => c.campo === k)!.titulo);
        else datos[k] = n;
      } else {
        datos[k] = String(v).trim();
      }
    });
    if (r.codigo || r.descripcion) out.push(r);
  });
  return out;
}

export type AccionFila = 'crear' | 'actualizar';
export interface FilaPlan { f: FilaPlantilla; accion: AccionFila; codigo: string; productoId?: string; cambios: CambiosProducto }
export interface ErrorFila { fila: number; codigo: string; mensaje: string }

export interface PlanImportacion {
  nuevos: number;
  actualizados: number; // productos existentes con algún dato distinto
  conteos: number; // filas con stock contado
  sinPrecio: number; // productos nuevos sin precio detal (no se pueden vender aún)
  errores: ErrorFila[];
  filas: FilaPlan[];
}

const clave = (descripcion: string, moto?: string | null, ref?: string | null) =>
  [normalizar(descripcion), normalizar(moto ?? ''), normalizar(ref ?? '')].join('|');
const definido = <T,>(v: T | undefined): v is T => v !== undefined;

/** Revisa la hoja contra el catálogo actual sin cambiar nada. */
export async function analizarPlantilla(d: PosDB, filas: FilaPlantilla[]): Promise<PlanImportacion> {
  const productos = await d.productos.toArray();
  const porCodigo = new Map(productos.map((p) => [p.codigo.toUpperCase(), p]));
  const porClave = new Map(productos.map((p) => [clave(p.descripcion, p.marcaAplica, p.refProveedor), p]));
  const prefijo = await prefijoCodigo(d);
  const usados = new Set<string>([...porCodigo.keys(), ...filas.map((f) => f.codigo.toUpperCase()).filter(Boolean)]);
  const vistos = new Set<string>();
  const clavesNuevas = new Set<string>();
  const plan: PlanImportacion = { nuevos: 0, actualizados: 0, conteos: 0, sinPrecio: 0, errores: [], filas: [] };
  const error = (f: FilaPlantilla, mensaje: string) => plan.errores.push({ fila: f.fila, codigo: f.codigo || '(sin código)', mensaje });

  for (const f of filas) {
    const cod = f.codigo.toUpperCase();
    if (f.invalidos.length) { error(f, `Número no válido en ${f.invalidos.join(', ')}`); continue; }
    if (/\s/.test(cod)) { error(f, 'El código no puede tener espacios'); continue; }
    if (cod && vistos.has(cod)) { error(f, 'Código repetido en el archivo'); continue; }
    if (cod) vistos.add(cod);
    if (definido(f.stockContado) && (!Number.isInteger(f.stockContado) || f.stockContado < 0)) { error(f, 'El stock contado debe ser un entero de 0 o más'); continue; }
    if (definido(f.stockMinimo) && (!Number.isInteger(f.stockMinimo) || f.stockMinimo < 0)) { error(f, 'El stock mínimo debe ser un entero de 0 o más'); continue; }
    if (definido(f.costo) && f.costo < 0) { error(f, 'El costo no puede ser negativo'); continue; }

    const p: Producto | undefined = cod ? porCodigo.get(cod) : undefined;
    if (!p) {
      // Producto nuevo
      if (!f.descripcion) { error(f, cod ? 'El código no existe y la fila no tiene descripción' : 'Falta la descripción'); continue; }
      const k = clave(f.descripcion, f.moto, f.refProveedor);
      const igual = porClave.get(k);
      if (!cod && igual) { error(f, `Ya existe como ${igual.codigo}: escribe ese código en la fila para actualizarlo`); continue; }
      if (!cod && clavesNuevas.has(k)) { error(f, 'Producto repetido en el archivo (misma descripción, motos y referencia)'); continue; }
      clavesNuevas.add(k);
      const precios = { costo: f.costo ?? 0, precioDetal: f.precioDetal ?? null, precioMayor: f.precioMayor ?? null, cantMinMayor: f.cantMinMayor ?? null };
      const bloq = revisarPrecios(precios).find((x) => x.bloquea);
      if (bloq) { error(f, bloq.mensaje); continue; }
      let codigo = cod;
      if (!codigo) { codigo = siguienteDe(usados, prefijo); usados.add(codigo); }
      plan.nuevos++;
      if (precios.precioDetal === null) plan.sinPrecio++;
      if (definido(f.stockContado)) plan.conteos++;
      plan.filas.push({ f, accion: 'crear', codigo, cambios: {} });
      continue;
    }

    // Producto existente: solo cambian las celdas que vienen llenas.
    const cambios: CambiosProducto = {};
    const texto = (v: string | undefined, actual: string | null | undefined, k: keyof CambiosProducto, norm = true) => {
      if (v === undefined) return;
      const nuevo = norm ? normalizar(v) : v.trim();
      if (nuevo !== (actual ?? '')) (cambios as Record<string, unknown>)[k] = nuevo;
    };
    texto(f.descripcion, p.descripcion, 'descripcion');
    texto(f.familia, p.familia, 'familia');
    texto(f.moto, p.marcaAplica, 'marcaAplica');
    texto(f.proveedor, p.proveedor, 'proveedor');
    texto(f.refProveedor, p.refProveedor, 'refProveedor', false);
    if (definido(f.costo) && f.costo !== p.costo) cambios.costo = f.costo;
    if (definido(f.precioDetal) && f.precioDetal !== p.precioDetal) cambios.precioDetal = f.precioDetal;
    if (definido(f.precioMayor) && f.precioMayor !== p.precioMayor) cambios.precioMayor = f.precioMayor;
    if (definido(f.cantMinMayor) && f.cantMinMayor !== p.cantMinMayor) cambios.cantMinMayor = f.cantMinMayor;
    if (definido(f.stockMinimo) && f.stockMinimo !== p.stockMinimo) cambios.stockMinimo = f.stockMinimo;
    const bloq = revisarPrecios({ ...p, ...cambios }).find((x) => x.bloquea);
    if (bloq) { error(f, bloq.mensaje); continue; }
    const hayCambios = Object.keys(cambios).length > 0;
    if (hayCambios) plan.actualizados++;
    if (definido(f.stockContado)) plan.conteos++;
    if (hayCambios || definido(f.stockContado)) plan.filas.push({ f, accion: 'actualizar', codigo: p.codigo, productoId: p.id, cambios });
  }
  return plan;
}

/** Aplica el plan: crea productos, actualiza datos y registra el stock contado. */
export async function aplicarPlantilla(d: PosDB, ctx: Contexto, plan: PlanImportacion, alAvanzar?: (hechas: number) => void): Promise<ErrorFila[]> {
  exigir(ctx, 'editar_productos');
  if (plan.conteos > 0) exigir(ctx, 'mover_inventario');
  const errores: ErrorFila[] = [];
  let i = 0;
  for (const { f, accion, codigo, productoId, cambios } of plan.filas) {
    try {
      let id = productoId;
      if (accion === 'crear') {
        const p = await crearProducto(d, ctx, {
          codigo, descripcion: f.descripcion ?? '', familia: f.familia ?? null, marcaAplica: f.moto ?? null,
          proveedor: f.proveedor ?? null, refProveedor: f.refProveedor ?? null, costo: f.costo ?? 0,
          precioDetal: f.precioDetal ?? null, precioMayor: f.precioMayor ?? null, cantMinMayor: f.cantMinMayor ?? null,
          stockMinimo: f.stockMinimo ?? 0,
        });
        id = p.id;
      } else if (Object.keys(cambios).length) {
        await guardarProducto(d, ctx, id!, cambios);
      }
      if (definido(f.stockContado)) await registrarConteo(d, ctx, id!, f.stockContado, accion === 'crear' ? 'Inventario inicial (plantilla Excel)' : 'Conteo físico (plantilla Excel)');
    } catch (e) {
      errores.push({ fila: f.fila, codigo, mensaje: e instanceof Error ? e.message : String(e) });
    }
    alAvanzar?.(++i);
  }
  return errores;
}
