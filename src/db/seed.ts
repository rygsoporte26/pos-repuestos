import type { PosDB } from './db';
import { getMeta, setMeta } from './db';
import type { Movimiento, Negocio, Producto, Sede, Usuario } from './types';
import { textoBusqueda } from '../domain/buscar';
import { stockKey } from '../domain/inventario';
import { uuid } from '../domain/util';
import { PRODUCTOS_DEMO } from '../data/demo';

export const NEGOCIO_POR_DEFECTO: Negocio = {
  nombre: 'Repuestos (nombre por definir)',
  direccion: '',
  telefono: '',
  mensajeTicket: 'Gracias por su compra',
  prefijoCodigo: 'RYG',
};

/** Primera apertura del modo demo: sede, usuarios de prueba, dispositivo y productos de ejemplo con stock. */
export async function inicializar(d: PosDB) {
  if (await getMeta<boolean>(d, 'inicializado', false)) return;
  await d.transaction('rw', [d.sedes, d.usuarios, d.productos, d.movimientos, d.stock, d.meta], async () => {
    if (await getMeta<boolean>(d, 'inicializado', false)) return;
    const sede: Sede = { id: uuid(), codigo: 'S1', nombre: 'Tienda principal' };
    await d.sedes.add(sede);
    const usuarios: Usuario[] = [
      { id: uuid(), nombre: 'Papá (administrador)', rol: 'admin', sedeId: sede.id, activo: true },
      { id: uuid(), nombre: 'Vendedor 1', rol: 'vendedor', sedeId: sede.id, activo: true },
      { id: uuid(), nombre: 'Supervisor (Colombia)', rol: 'supervisor', sedeId: null, activo: true },
    ];
    await d.usuarios.bulkAdd(usuarios);
    const ahora = new Date().toISOString();
    const prods: Producto[] = [];
    const movs: Movimiento[] = [];
    for (const [codigo, descripcion, familia, moto, proveedor, ref, costo, detal, mayor, min, stock, smin] of PRODUCTOS_DEMO) {
      const p: Producto = {
        id: uuid(), codigo, descripcion, familia, marcaAplica: moto, presentacion: null, unidadesBulto: null, unidadCompra: 'PIEZA',
        costo, precioDetal: detal, precioMayor: mayor, cantMinMayor: min, stockMinimo: smin, proveedor, refProveedor: ref,
        activo: true, actualizadoEn: ahora, busqueda: '',
      };
      p.busqueda = textoBusqueda(p);
      prods.push(p);
      if (stock > 0) movs.push({
        id: uuid(), sedeId: sede.id, productoId: p.id, tipo: 'inicial', cantidad: stock, costoUnitario: costo, referenciaId: null,
        nota: 'Inventario inicial (demo)', proveedor: null, usuarioId: usuarios[0].id, usuarioNombre: usuarios[0].nombre, creadoEn: ahora,
      });
    }
    await d.productos.bulkAdd(prods);
    await d.movimientos.bulkAdd(movs);
    await d.stock.bulkAdd(movs.map((m) => ({ key: stockKey(sede.id, m.productoId), sedeId: sede.id, productoId: m.productoId, stock: m.cantidad })));
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
