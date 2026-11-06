import Dexie, { type Table } from 'dexie';
import type {
  Meta, Movimiento, OutboxItem, PedidoMayor, Producto, Sede, SesionCaja, Stock, Usuario, Venta,
} from './types';

// Base local del navegador (IndexedDB). Es la que usa la caja siempre, con o sin
// internet. La sincronización con Supabase lee el outbox y lo envía a la nube.
export class PosDB extends Dexie {
  productos!: Table<Producto, string>;
  movimientos!: Table<Movimiento, string>;
  stock!: Table<Stock, string>;
  ventas!: Table<Venta, string>;
  sesiones!: Table<SesionCaja, string>;
  usuarios!: Table<Usuario, string>;
  sedes!: Table<Sede, string>;
  outbox!: Table<OutboxItem, number>;
  meta!: Table<Meta, string>;
  pedidos!: Table<PedidoMayor, string>;

  constructor(nombre = 'pos-repuestos') {
    super(nombre);
    // Para cambiar índices: agregar this.version(2).stores({...}) sin borrar la 1.
    this.version(1).stores({
      productos: 'id, &codigo, familia, activo',
      movimientos: 'id, productoId, sedeId, creadoEn, referenciaId',
      stock: 'key, productoId, sedeId',
      ventas: 'id, numero, dia, sesionCajaId, estado, creadaEn',
      sesiones: 'id, dispositivoId, abiertaEn, cerradaEn',
      usuarios: 'id',
      sedes: 'id, &codigo',
      outbox: '++seq, tipo, refId',
      meta: 'clave',
    });
    // 1.3.0: pedidos de clientes mayoristas.
    this.version(2).stores({ pedidos: 'id, numero, sedeId, estado, creadoEn' });
  }
}

// Demo y nube usan bases locales distintas para no mezclar datos de prueba.
export const db = new PosDB(import.meta.env.VITE_SUPABASE_URL ? 'pos-nube' : 'pos-repuestos');

export async function getMeta<T>(d: PosDB, clave: string, defecto: T): Promise<T> {
  const m = await d.meta.get(clave);
  return (m?.valor as T) ?? defecto;
}

export function setMeta(d: PosDB, clave: string, valor: unknown) {
  return d.meta.put({ clave, valor });
}

export type DatosDispositivo = { id: string; codigo: string; sedeId: string | null };

/**
 * Cambia datos de este equipo (código de caja, sede) leyendo y guardando en una sola
 * transacción, para que la sincronización y la pantalla no se pisen el cambio.
 */
export function actualizarDispositivo(d: PosDB, cambios: Partial<Omit<DatosDispositivo, 'id'>>) {
  return d.transaction('rw', d.meta, async () => {
    const actual = await getMeta<DatosDispositivo | null>(d, 'dispositivo', null);
    if (!actual) return null;
    if (Object.entries(cambios).every(([k, v]) => actual[k as keyof DatosDispositivo] === v)) return actual;
    const nuevo = { ...actual, ...cambios };
    await setMeta(d, 'dispositivo', nuevo);
    return nuevo;
  });
}
