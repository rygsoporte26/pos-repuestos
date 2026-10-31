import type { PosDB } from '../db/db';
import type { MedioPago, SesionCaja } from '../db/types';
import { totalesPorMedio, type TotalMedio } from './pagos';
import { ErrorNegocio, exigir, type Contexto } from './contexto';
import { encolar } from '../sync/outbox';
import { round2, uuid } from './util';

/** Caja abierta de ESTE dispositivo (una sola a la vez). */
export async function sesionAbierta(d: PosDB, dispositivoId: string): Promise<SesionCaja | undefined> {
  return d.sesiones.where('dispositivoId').equals(dispositivoId).filter((s) => s.cerradaEn === null).first();
}

export async function abrirCaja(d: PosDB, ctx: Contexto, efectivoInicial: number, efectivoInicialBs = 0): Promise<SesionCaja> {
  exigir(ctx, 'caja');
  if (!(efectivoInicial >= 0) || !(efectivoInicialBs >= 0)) throw new ErrorNegocio('La base debe ser 0 o más');
  return d.transaction('rw', [d.sesiones, d.outbox], async () => {
    if (await sesionAbierta(d, ctx.dispositivoId)) throw new ErrorNegocio('Ya hay una caja abierta en este equipo');
    const s: SesionCaja = {
      id: uuid(), sedeId: ctx.sedeId, dispositivoId: ctx.dispositivoId, usuarioId: ctx.usuario.id,
      usuarioNombre: ctx.usuario.nombre, abiertaEn: new Date().toISOString(), efectivoInicial: round2(efectivoInicial),
      efectivoInicialBs: round2(efectivoInicialBs), cerradaEn: null, efectivoContado: null, efectivoEsperado: null, diferencia: null,
      efectivoContadoBs: null, efectivoEsperadoBs: null, diferenciaBs: null, resumen: null, notas: null,
    };
    await d.sesiones.add(s);
    await encolar(d, 'sesion_caja', s.id, s);
    return s;
  });
}

export interface ResumenCaja {
  ventas: number; // tickets completados
  anuladas: number;
  montoAnulado: number; // USD
  porMedio: Partial<Record<MedioPago, TotalMedio>>; // lo cobrado por cada método (vueltos restados)
  totalUsd: number; // vendido (USD)
  esperado: number; // efectivo $ que debe haber: base + efectivo $ cobrado − vueltos $
  esperadoBs: number; // efectivo Bs que debe haber
}

/** Lo que debería haber en la caja. Las anuladas no cuentan (el dinero se devolvió). */
export async function resumenCaja(d: PosDB, s: SesionCaja): Promise<ResumenCaja> {
  const ventas = await d.ventas.where('sesionCajaId').equals(s.id).toArray();
  const ok = ventas.filter((v) => v.estado === 'completada');
  const an = ventas.filter((v) => v.estado === 'anulada');
  const porMedio = totalesPorMedio(ok.flatMap((v) => v.pagos));
  return {
    ventas: ok.length, anuladas: an.length, montoAnulado: round2(an.reduce((a, v) => a + v.total, 0)), porMedio,
    totalUsd: round2(ok.reduce((a, v) => a + v.total, 0)),
    esperado: round2(s.efectivoInicial + (porMedio.efectivo_usd?.montoMoneda ?? 0)),
    esperadoBs: round2((s.efectivoInicialBs ?? 0) + (porMedio.efectivo_bs?.montoMoneda ?? 0)),
  };
}

/** Cierre con arqueo: se cuenta el efectivo en $ y en Bs; queda la diferencia de cada uno. */
export async function cerrarCaja(d: PosDB, ctx: Contexto, efectivoContado: number, efectivoContadoBs: number, notas?: string): Promise<SesionCaja> {
  exigir(ctx, 'caja');
  if (!(efectivoContado >= 0) || !(efectivoContadoBs >= 0)) throw new ErrorNegocio('El efectivo contado debe ser 0 o más');
  return d.transaction('rw', [d.sesiones, d.ventas, d.outbox], async () => {
    const s = await sesionAbierta(d, ctx.dispositivoId);
    if (!s) throw new ErrorNegocio('No hay caja abierta en este equipo');
    const r = await resumenCaja(d, s);
    const cerrada: SesionCaja = {
      ...s, cerradaEn: new Date().toISOString(),
      efectivoContado: round2(efectivoContado), efectivoEsperado: r.esperado, diferencia: round2(efectivoContado - r.esperado),
      efectivoInicialBs: s.efectivoInicialBs ?? 0, efectivoContadoBs: round2(efectivoContadoBs), efectivoEsperadoBs: r.esperadoBs,
      diferenciaBs: round2(efectivoContadoBs - r.esperadoBs), resumen: r.porMedio, notas: notas?.trim() || null,
    };
    await d.sesiones.put(cerrada);
    await encolar(d, 'sesion_caja', cerrada.id, cerrada);
    return cerrada;
  });
}
