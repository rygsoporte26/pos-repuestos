import type { Rol, Usuario } from '../db/types';

/** Quién opera, en qué sede y desde qué caja. Todas las operaciones lo reciben. */
export interface Contexto {
  usuario: Usuario;
  sedeId: string;
  sedeCodigo: string;
  dispositivoId: string;
  dispositivoCodigo: string; // 'C1'
}

export type Accion =
  | 'vender' | 'caja' | 'ver_ventas' | 'anular' | 'editar_productos'
  | 'mover_inventario' | 'ver_panel' | 'ajustes' | 'usuarios' | 'ver_ajustes';

const PERMISOS: Record<Rol, Accion[]> = {
  vendedor: ['vender', 'caja', 'ver_ventas', 'ver_ajustes'],
  admin: ['vender', 'caja', 'ver_ventas', 'anular', 'editar_productos', 'mover_inventario', 'ver_panel', 'ajustes', 'usuarios', 'ver_ajustes'],
  supervisor: ['ver_ventas', 'anular', 'editar_productos', 'mover_inventario', 'ver_panel', 'ajustes', 'usuarios', 'ver_ajustes'],
};

export const puede = (rol: Rol, accion: Accion) => PERMISOS[rol].includes(accion);

export class ErrorNegocio extends Error {}

export function exigir(ctx: Contexto, accion: Accion) {
  if (!puede(ctx.usuario.rol, accion)) throw new ErrorNegocio('No tienes permiso para esta acción');
}
