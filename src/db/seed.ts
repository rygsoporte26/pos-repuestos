import type { PosDB } from './db';
import { getMeta, setMeta } from './db';
import type { Negocio, Producto, Sede, Usuario } from './types';
import { textoBusqueda } from '../domain/buscar';
import { uuid } from '../domain/util';

// Catálogo GP Motocycles (lista del 21-09-2026). Regenerar con scripts/catalogo.py.
type FilaGP = { c: string; f: string | null; m: string | null; d: string; p: string | null; u: string | null; b: number | null; k: number };

export const NEGOCIO_POR_DEFECTO: Negocio = {
  nombre: 'Repuestos (nombre por definir)',
  direccion: '',
  telefono: '',
  mensajeTicket: 'Gracias por su compra',
};

export function filaAProducto(r: FilaGP): Producto {
  const p: Producto = {
    id: uuid(), codigo: r.c, descripcion: r.d, familia: r.f, marcaAplica: r.m, presentacion: r.p,
    unidadesBulto: r.b, unidadCompra: r.u, costo: r.k, precioDetal: null, precioMayor: null, cantMinMayor: null,
    stockMinimo: 0, activo: true, actualizadoEn: new Date().toISOString(), busqueda: '',
  };
  p.busqueda = textoBusqueda(p);
  return p;
}

/** Primera apertura: crea sede, usuarios de demo, dispositivo y carga el catálogo. */
export async function inicializar(d: PosDB) {
  if (await getMeta<boolean>(d, 'inicializado', false)) return;
  const filas: FilaGP[] = (await import('../data/catalogo-gp.json')).default as FilaGP[];
  await d.transaction('rw', [d.sedes, d.usuarios, d.productos, d.meta], async () => {
    if (await getMeta<boolean>(d, 'inicializado', false)) return;
    const sede: Sede = { id: uuid(), codigo: 'S1', nombre: 'Tienda principal' };
    await d.sedes.add(sede);
    const usuarios: Usuario[] = [
      { id: uuid(), nombre: 'Papá (administrador)', rol: 'admin', sedeId: sede.id, activo: true },
      { id: uuid(), nombre: 'Vendedor 1', rol: 'vendedor', sedeId: sede.id, activo: true },
      { id: uuid(), nombre: 'Supervisor (Colombia)', rol: 'supervisor', sedeId: null, activo: true },
    ];
    await d.usuarios.bulkAdd(usuarios);
    await d.productos.bulkAdd(filas.map(filaAProducto));
    await setMeta(d, 'negocio', NEGOCIO_POR_DEFECTO);
    await setMeta(d, 'dispositivo', { id: uuid(), codigo: 'C1', sedeId: sede.id });
    await setMeta(d, 'inicializado', true);
  });
}

/** Modo nube: solo prepara el equipo. Catálogo, sedes y usuarios bajan de Supabase. */
export async function inicializarNube(d: PosDB) {
  if (!(await getMeta(d, 'dispositivo', null))) await setMeta(d, 'dispositivo', { id: uuid(), codigo: 'C1', sedeId: null });
  if (!(await getMeta(d, 'negocio', null))) await setMeta(d, 'negocio', NEGOCIO_POR_DEFECTO);
}

/** Productos del catálogo GP listos para subir a una nube vacía. */
export async function catalogoGP(): Promise<Producto[]> {
  const filas: FilaGP[] = (await import('../data/catalogo-gp.json')).default as FilaGP[];
  return filas.map(filaAProducto);
}
