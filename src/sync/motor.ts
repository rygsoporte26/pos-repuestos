import type { SupabaseClient } from '@supabase/supabase-js';
import type { PosDB } from '../db/db';
import { getMeta, setMeta } from '../db/db';
import type { Negocio, OutboxItem, Producto, Sede, SesionCaja, Tasa, Venta, Movimiento } from '../db/types';
import { puede, type Contexto } from '../domain/contexto';
import { stockKey } from '../domain/inventario';
import { nube, perfilAUsuario, type PerfilNube } from './nube';
import {
  movimientoANube, movimientoDeNube, productoANube, productoDeNube, sesionANube, sesionDeNube, ventaANube, ventaDeNube,
} from './mapeo';

declare const __APP_VERSION__: string;

export interface EstadoSync {
  enCurso: boolean;
  ultimoOk: string | null; // última sincronización completa
  error: string | null; // último error (se limpia al sincronizar bien)
  bloqueado: number | null; // seq del cambio que la nube rechazó
}

const LOTE = 200;
const SOLAPE_MS = 2 * 60 * 1000; // se vuelve a pedir 2 min hacia atrás por si algo llegó tarde
const HISTORIA_DIAS = 60; // un equipo nuevo baja ventas y movimientos de los últimos 60 días

export const leerEstado = (d: PosDB) => getMeta<EstadoSync>(d, 'sync', { enCurso: false, ultimoOk: null, error: null, bloqueado: null });
const guardarEstado = async (d: PosDB, cambios: Partial<EstadoSync>) => setMeta(d, 'sync', { ...(await leerEstado(d)), ...cambios });

class ErrorRed extends Error {}
class ErrorRechazo extends Error {}

/** Convierte la respuesta de Supabase en error de red (reintentar) o rechazo (revisar). */
function revisar<T>(r: { data: T; error: { message: string; code?: string; details?: string } | null; status?: number }): T {
  if (!r.error) return r.data;
  const sinRed = !r.status || r.status === 0 || /fetch|network|Failed to fetch|timeout/i.test(r.error.message);
  if (sinRed) throw new ErrorRed('Sin conexión con la nube');
  throw new ErrorRechazo(r.error.message + (r.error.details ? ` (${r.error.details})` : ''));
}

let enCurso: Promise<void> | null = null;

/**
 * Un ciclo completo: registra el equipo, sube los cambios pendientes en orden y baja
 * lo nuevo. Nunca corre dos veces a la vez. Si no hay internet, no hace nada.
 */
export function sincronizar(d: PosDB, ctx: Contexto): Promise<void> {
  if (enCurso) return enCurso;
  enCurso = (async () => {
    if (!navigator.onLine) { await guardarEstado(d, { enCurso: false, error: 'Sin internet: las ventas se guardan en este equipo' }); return; }
    await guardarEstado(d, { enCurso: true });
    try {
      const sb = nube();
      const { data } = await sb.auth.getSession();
      if (!data.session) throw new ErrorRechazo('La sesión expiró: sal y vuelve a entrar');
      if (ctx.sedeId && puede(ctx.usuario.rol, 'caja')) await registrarDispositivo(d, sb, ctx);
      await subir(d, sb);
      await bajar(d, sb, ctx);
      await guardarEstado(d, { enCurso: false, ultimoOk: new Date().toISOString(), error: null, bloqueado: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await guardarEstado(d, { enCurso: false, error: e instanceof ErrorRed ? 'Sin conexión con la nube: se reintenta solo' : msg });
    } finally {
      enCurso = null;
    }
  })();
  return enCurso;
}

async function registrarDispositivo(d: PosDB, sb: SupabaseClient, ctxIn: Contexto) {
  let ctx = ctxIn;
  // Primera vez de este PC: se le asigna el primer código de caja libre de la sede (C1, C2…).
  if (!(await getMeta<boolean>(d, 'codigo_asignado', false))) {
    const otros = revisar(await sb.from('dispositivos').select('id,codigo').eq('sede_id', ctx.sedeId)) as { id: string; codigo: string }[];
    const usados = new Set(otros.filter((o) => o.id !== ctx.dispositivoId).map((o) => o.codigo));
    let n = 1;
    while (usados.has(`C${n}`)) n++;
    const codigo = usados.has(ctx.dispositivoCodigo) ? `C${n}` : ctx.dispositivoCodigo;
    const disp = await getMeta<{ id: string; codigo: string; sedeId: string | null }>(d, 'dispositivo', { id: ctx.dispositivoId, codigo, sedeId: ctx.sedeId });
    await setMeta(d, 'dispositivo', { ...disp, codigo });
    await setMeta(d, 'codigo_asignado', true);
    ctx = { ...ctx, dispositivoCodigo: codigo };
  }
  revisar(await sb.from('dispositivos').upsert({
    id: ctx.dispositivoId, sede_id: ctx.sedeId, codigo: ctx.dispositivoCodigo, nombre: `Caja ${ctx.dispositivoCodigo}`,
    version_app: __APP_VERSION__, ultimo_sync: new Date().toISOString(),
  }));
  // Si el PC se reinstaló, el consecutivo de tickets continúa desde el último de la nube.
  const ultimo = revisar(await sb.rpc('ultimo_ticket', { p_sede: ctx.sedeId, p_prefijo: `${ctx.sedeCodigo}-${ctx.dispositivoCodigo}-` })) as string | null;
  if (ultimo) {
    const nServ = Number(ultimo.split('-').pop());
    const clave = `contador_ticket_${ctx.dispositivoId}`;
    if (nServ > (await getMeta<number>(d, clave, 0))) await setMeta(d, clave, nServ);
  }
}

// ---------------------------------------------------------------- SUBIR
async function subir(d: PosDB, sb: SupabaseClient) {
  for (;;) {
    const cola = await d.outbox.orderBy('seq').limit(LOTE).toArray();
    if (cola.length === 0) return;
    const primero = cola[0];
    // Productos y movimientos seguidos se envían en un solo lote.
    let fin = 1;
    if (primero.tipo === 'producto' || primero.tipo === 'movimiento' || primero.tipo === 'config') {
      while (fin < cola.length && cola[fin].tipo === primero.tipo) fin++;
    }
    const grupo: OutboxItem[] = cola.slice(0, fin);
    try {
      await enviar(sb, primero.tipo, grupo);
    } catch (e) {
      if (e instanceof ErrorRechazo) {
        await d.outbox.update(primero.seq!, { intentos: primero.intentos + 1, error: e.message });
        await guardarEstado(d, { bloqueado: primero.seq! });
        throw new ErrorRechazo(`La nube rechazó un cambio (${nombreTipo(primero.tipo)}): ${e.message}`);
      }
      throw e;
    }
    await d.outbox.bulkDelete(grupo.map((x) => x.seq!));
  }
}

async function enviar(sb: SupabaseClient, tipo: OutboxItem['tipo'], grupo: OutboxItem[]) {
  switch (tipo) {
    case 'producto': {
      // Si el mismo producto cambió varias veces, basta el último estado.
      const ult = new Map<string, Producto>();
      for (const x of grupo) ult.set(x.refId, x.payload as Producto);
      revisar(await sb.from('productos').upsert([...ult.values()].map(productoANube)));
      return;
    }
    case 'movimiento':
      revisar(await sb.rpc('mover_inventario_lote', { p_movs: grupo.map((x) => movimientoANube(x.payload as Movimiento)) }));
      return;
    case 'sesion_caja':
      revisar(await sb.from('sesiones_caja').upsert(sesionANube(grupo[0].payload as SesionCaja)));
      return;
    case 'venta':
      revisar(await sb.rpc('registrar_venta', { payload: ventaANube(grupo[0].payload as Venta) }));
      return;
    case 'config': {
      // Solo cuenta el último valor de cada clave (ej. la tasa del día).
      const ult = new Map<string, unknown>();
      for (const x of grupo) { const p = x.payload as { clave: string; valor: unknown }; ult.set(p.clave, p.valor); }
      revisar(await sb.from('config').upsert([...ult.entries()].map(([clave, valor]) => ({ clave, valor }))));
      return;
    }
    case 'anulacion': {
      const p = grupo[0].payload as { ventaId: string; motivo: string; movs?: Record<string, string> };
      revisar(await sb.rpc('anular_venta', { p_venta: p.ventaId, p_motivo: p.motivo, p_movs: p.movs ?? {} }));
      return;
    }
  }
}

export const nombreTipo = (t: OutboxItem['tipo']) =>
  ({ producto: 'producto', movimiento: 'inventario', sesion_caja: 'caja', venta: 'venta', anulacion: 'anulación', config: 'tasa o ajustes' })[t];

// ---------------------------------------------------------------- BAJAR
async function cursor(d: PosDB, nombre: string): Promise<string> {
  const c = await getMeta<string | null>(d, `cursor_${nombre}`, null);
  const base = c ? new Date(c).getTime() - SOLAPE_MS : Date.now() - HISTORIA_DIAS * 864e5;
  return new Date(base).toISOString();
}

/** Baja en páginas de 1000 filas (límite de Supabase) ordenando por la columna de cambio. */
async function paginado(sb: SupabaseClient, tabla: string, select: string, col: string, desde: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; ; i += 1000) {
    const filas = revisar(await sb.from(tabla).select(select).gte(col, desde).order(col).order('id').range(i, i + 999)) as unknown as Record<string, unknown>[];
    out.push(...filas);
    if (filas.length < 1000) return out;
  }
}

const maxFecha = (filas: Record<string, unknown>[], col: string, previo: string | null) =>
  filas.reduce<string | null>((m, f) => (!m || (f[col] as string) > m ? (f[col] as string) : m), previo);

async function bajar(d: PosDB, sb: SupabaseClient, ctx: Contexto) {
  const pendientesIds = new Set((await d.outbox.toArray()).map((x) => x.refId));

  // Sedes, usuarios y datos del negocio (pocos registros: se bajan completos).
  const sedes = revisar(await sb.from('sedes').select('id,codigo,nombre')) as Sede[];
  await d.sedes.bulkPut(sedes);
  const perfiles = revisar(await sb.from('perfiles').select('id,nombre,rol,sede_id,activo,email')) as PerfilNube[];
  await d.usuarios.bulkPut(perfiles.map(perfilAUsuario));
  const conf = revisar(await sb.from('config').select('clave,valor').in('clave', ['negocio', 'tasa'])) as { clave: string; valor: unknown }[];
  for (const c of conf) {
    if (c.clave === 'negocio') await setMeta(d, 'negocio', c.valor as Negocio);
    if (c.clave === 'tasa' && !pendientesIds.has('tasa')) await setMeta(d, 'tasa', c.valor as Tasa);
  }

  // Productos cambiados.
  const prods = await paginado(sb, 'productos', '*', 'actualizado_en', await cursor(d, 'productos'));
  if (prods.length) {
    await d.productos.bulkPut(prods.filter((r) => !pendientesIds.has(r.id as string)).map(productoDeNube));
    await setMeta(d, 'cursor_productos', maxFecha(prods, 'actualizado_en', null));
  }

  // Ventas, cajas y movimientos (de las sedes que el usuario puede ver).
  const codigos = new Map((await d.productos.toArray()).map((p) => [p.id, p.codigo]));
  const ventas = await paginado(sb, 'ventas', '*,venta_items(*),pagos(*)', 'actualizado_en', await cursor(d, 'ventas'));
  if (ventas.length) {
    await d.ventas.bulkPut(ventas.filter((r) => !pendientesIds.has(r.id as string)).map((r) => ventaDeNube(r, codigos)));
    await setMeta(d, 'cursor_ventas', maxFecha(ventas, 'actualizado_en', null));
  }
  const sesiones = await paginado(sb, 'sesiones_caja', '*', 'actualizado_en', await cursor(d, 'sesiones'));
  if (sesiones.length) {
    await d.sesiones.bulkPut(sesiones.filter((r) => !pendientesIds.has(r.id as string)).map(sesionDeNube));
    await setMeta(d, 'cursor_sesiones', maxFecha(sesiones, 'actualizado_en', null));
  }
  const movs = await paginado(sb, 'movimientos_inventario', '*', 'recibido_en', await cursor(d, 'movimientos'));
  if (movs.length) {
    await d.movimientos.bulkPut(movs.map(movimientoDeNube));
    await setMeta(d, 'cursor_movimientos', maxFecha(movs, 'recibido_en', null));
  }

  // Stock oficial: solo si no quedan cambios locales sin subir (si no, se perderían).
  if ((await d.outbox.count()) === 0) {
    const stock = [] as { sede_id: string; producto_id: string; stock: number }[];
    for (let i = 0; ; i += 1000) {
      const f = revisar(await sb.from('stock_actual').select('sede_id,producto_id,stock').order('producto_id').order('sede_id').range(i, i + 999)) as typeof stock;
      stock.push(...f);
      if (f.length < 1000) break;
    }
    await d.transaction('rw', d.stock, async () => {
      await d.stock.clear();
      await d.stock.bulkPut(stock.map((s) => ({ key: stockKey(s.sede_id, s.producto_id), sedeId: s.sede_id, productoId: s.producto_id, stock: Number(s.stock) })));
    });
  }
  void ctx;
}

// ---------------------------------------------------------------- PROGRAMACIÓN
/**
 * Sincroniza al abrir, cada 30 s, al volver internet y poco después de cada venta o
 * cambio. Devuelve una función para detenerlo (al cerrar sesión).
 */
export function arrancarSync(d: PosDB, ctx: () => Contexto | null): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const correr = () => { const c = ctx(); if (c) void sincronizar(d, c); };
  const pronto = () => { if (t) clearTimeout(t); t = setTimeout(correr, 1500); };
  correr();
  const iv = setInterval(correr, 30_000);
  window.addEventListener('online', correr);
  window.addEventListener('pos-outbox', pronto);
  return () => {
    clearInterval(iv); if (t) clearTimeout(t);
    window.removeEventListener('online', correr);
    window.removeEventListener('pos-outbox', pronto);
  };
}

/** Quita de la cola un cambio que la nube rechaza (queda guardado en "descartados"). */
export async function descartarCambio(d: PosDB, seq: number) {
  const item = await d.outbox.get(seq);
  if (!item) return;
  const desc = await getMeta<OutboxItem[]>(d, 'descartados', []);
  await setMeta(d, 'descartados', [...desc, { ...item, error: item.error ?? 'descartado' }].slice(-200));
  await d.outbox.delete(seq);
  await guardarEstado(d, { bloqueado: null, error: null });
}

/** Olvida los cursores para volver a bajar todo (si algo se ve desactualizado). */
export async function rebajarTodo(d: PosDB, ctx: Contexto) {
  for (const c of ['productos', 'ventas', 'sesiones', 'movimientos']) await setMeta(d, `cursor_${c}`, null);
  await sincronizar(d, ctx);
}
