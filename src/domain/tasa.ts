import type { PosDB } from '../db/db';
import { getMeta, setMeta } from '../db/db';
import type { Tasa } from '../db/types';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { encolar } from '../sync/outbox';
import { diaLocal } from './util';

/** Tasa BCV vigente en este equipo (la última que cargó el administrador). */
export const leerTasa = (d: PosDB) => getMeta<Tasa | null>(d, 'tasa', null);

/** ¿La tasa es de hoy? Si no, se puede seguir cobrando pero se avisa. */
export const tasaDeHoy = (t: Tasa | null) => !!t && t.fecha === diaLocal();

export async function guardarTasa(d: PosDB, ctx: Contexto, valor: number, fuente: Tasa['fuente'] = 'manual'): Promise<Tasa> {
  exigir(ctx, 'ajustes');
  if (!(valor > 0) || !Number.isFinite(valor)) throw new ErrorNegocio('La tasa debe ser un número mayor que 0');
  const anterior = await leerTasa(d);
  if (anterior && (valor > anterior.valor * 1.5 || valor < anterior.valor * 0.67)) {
    throw new ErrorNegocio(`La tasa ${valor} es muy distinta a la anterior (${anterior.valor}). Revisa que no falte o sobre un dígito.`);
  }
  const t: Tasa = { valor: Math.round(valor * 10000) / 10000, fecha: diaLocal(), fuente, actualizadoEn: new Date().toISOString(), actualizadoPor: ctx.usuario.nombre };
  await d.transaction('rw', [d.meta, d.outbox], async () => {
    await setMeta(d, 'tasa', t);
    await encolar(d, 'config', 'tasa', { clave: 'tasa', valor: t });
  });
  return t;
}

/**
 * Sugerencia automática de la tasa oficial (BCV) desde DolarApi cuando hay internet.
 * Es solo una ayuda: el administrador la revisa antes de guardarla.
 */
export async function consultarTasaBcv(): Promise<number> {
  const r = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new ErrorNegocio('No se pudo consultar la tasa BCV. Escríbela a mano.');
  const j = (await r.json()) as { promedio?: number; venta?: number };
  const v = Number(j.promedio ?? j.venta);
  if (!(v > 0)) throw new ErrorNegocio('La consulta no devolvió una tasa válida. Escríbela a mano.');
  return v;
}
