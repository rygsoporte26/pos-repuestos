import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { abrirCaja, cerrarCaja, resumenCaja, sesionAbierta } from '../../domain/caja';
import { bs, enMoneda, fechaHora, parseNum, round2, usd } from '../../domain/util';
import { MEDIOS, type TotalMedio } from '../../domain/pagos';
import type { MedioPago } from '../../db/types';
import { Campo, useAccion, useApp } from '../components/ui';
import { leerEstado } from '../../sync/motor';
import { MODO_NUBE } from '../../sync/nube';
import { getMeta } from '../../db/db';

export function Caja() {
  const { ctx, irA } = useApp();
  const accion = useAccion();
  const sesion = useLiveQuery(async () => (await sesionAbierta(db, ctx.dispositivoId)) ?? null, [ctx.dispositivoId]);
  const resumen = useLiveQuery(async () => (sesion ? resumenCaja(db, sesion) : null), [sesion?.id]);
  const historial = useLiveQuery(
    () => db.sesiones.where('dispositivoId').equals(ctx.dispositivoId).filter((s) => s.cerradaEn !== null).reverse().sortBy('abiertaEn'),
    [ctx.dispositivoId],
  );
  const [base, setBase] = useState('20');
  const [baseBs, setBaseBs] = useState('0');
  const [contado, setContado] = useState('');
  const [contadoBs, setContadoBs] = useState('');
  const [notas, setNotas] = useState('');
  const [confirmar, setConfirmar] = useState(false);
  const aviso = useLiveQuery(async () => (await leerEstado(db)).aviso ?? null, []);
  // Un equipo nuevo no abre caja hasta recibir su código de la nube (evita tickets repetidos).
  const registrado = useLiveQuery(async () => !MODO_NUBE || (await getMeta<boolean>(db, 'codigo_asignado', false)), []);

  if (sesion === undefined) return <div className="muted">Cargando…</div>;

  const nContado = parseNum(contado);
  const nContadoBs = parseNum(contadoBs);
  const dif = resumen && nContado !== null ? round2(nContado - resumen.esperado) : null;
  const difBs = resumen && nContadoBs !== null ? round2(nContadoBs - resumen.esperadoBs) : null;
  const textoDif = (d: number, f: (n: number) => string) => (d === 0 ? 'cuadra exacto' : d > 0 ? `sobran ${f(d)}` : `faltan ${f(-d)}`);

  return (
    <>
      <h1>Caja {ctx.dispositivoCodigo}</h1>
      {aviso && <div className="alert bad">{aviso}</div>}
      {!sesion && registrado === false ? (
        <div className="panel" style={{ maxWidth: 560 }}>
          <h2>Conectando este equipo…</h2>
          <div className="muted">La primera vez, el equipo recibe su código de caja (C1, C2…) desde la nube. Necesita internet; tarda unos segundos.</div>
        </div>
      ) : !sesion ? (
        <form className="panel" style={{ maxWidth: 560 }} onSubmit={async (e) => {
          e.preventDefault();
          const n = parseNum(base), nb = parseNum(baseBs) ?? 0;
          if (n === null) return;
          const s = await accion(() => abrirCaja(db, ctx, n, nb), 'Caja abierta');
          if (s) irA('vender');
        }}>
          <h2>Abrir caja</h2>
          <p className="muted" style={{ margin: 0 }}>Cuenta el efectivo con el que empiezas el día para dar vuelto, en dólares y en bolívares.</p>
          <div className="row">
            <Campo label="Base en efectivo $"><input id="base" className="input search" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} /></Campo>
            <Campo label="Base en efectivo Bs"><input id="base-bs" className="input search" inputMode="decimal" value={baseBs} onChange={(e) => setBaseBs(e.target.value)} /></Campo>
          </div>
          <div><button className="btn primary big" type="submit" disabled={parseNum(base) === null || parseNum(baseBs) === null}>Abrir caja</button></div>
        </form>
      ) : (
        <div className="panel" style={{ maxWidth: 760 }}>
          <div className="row center">
            <h2>Caja abierta</h2>
            <span className="badge good">Abierta</span>
          </div>
          <div className="muted small">Desde {fechaHora(sesion.abiertaEn)} · {sesion.usuarioNombre} · {resumen?.ventas ?? 0} {resumen?.ventas === 1 ? 'venta' : 'ventas'} por {usd(resumen?.totalUsd ?? 0)}{resumen?.anuladas ? ` · ${resumen.anuladas} anuladas (no cuentan)` : ''}</div>
          {resumen && <TablaMedios porMedio={resumen.porMedio} />}
          <table>
            <thead><tr><th>Efectivo en caja</th><th className="num">Dólares</th><th className="num">Bolívares</th></tr></thead>
            <tbody>
              <tr><td>Base</td><td className="num">{usd(sesion.efectivoInicial)}</td><td className="num">{bs(sesion.efectivoInicialBs ?? 0)}</td></tr>
              <tr><td>Cobrado en efectivo menos vueltos</td><td className="num">{usd(resumen?.porMedio.efectivo_usd?.montoMoneda ?? 0)}</td><td className="num">{bs(resumen?.porMedio.efectivo_bs?.montoMoneda ?? 0)}</td></tr>
              <tr><td><strong>Debe haber</strong></td><td className="num"><strong>{usd(resumen?.esperado)}</strong></td><td className="num"><strong>{bs(resumen?.esperadoBs)}</strong></td></tr>
            </tbody>
          </table>
          <div className="muted small">Punto de venta, Biopago, pago móvil y Binance no se cuentan en caja: se cuadran con el banco y la app usando las referencias.</div>
          <h3>Cerrar caja (arqueo)</h3>
          <div className="row">
            <Campo label="Efectivo contado $"><input id="contado" className="input" inputMode="decimal" value={contado} onChange={(e) => { setContado(e.target.value); setConfirmar(false); }} /></Campo>
            <Campo label="Efectivo contado Bs"><input id="contado-bs" className="input" inputMode="decimal" value={contadoBs} onChange={(e) => { setContadoBs(e.target.value); setConfirmar(false); }} /></Campo>
            <Campo label="Notas (opcional)"><input id="notas-cierre" className="input" value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
          </div>
          {dif !== null && difBs !== null && (
            <div className={`alert ${dif === 0 && difBs === 0 ? 'good' : dif < 0 || difBs < 0 ? 'bad' : 'warn'}`}>
              Dólares: {textoDif(dif, usd)}. Bolívares: {textoDif(difBs, bs)}.
            </div>
          )}
          {!confirmar ? (
            <div><button className="btn primary" disabled={nContado === null || nContadoBs === null} onClick={() => setConfirmar(true)}>Cerrar caja</button></div>
          ) : (
            <div className="alert info row center">
              <span>¿Cerrar la caja con {usd(nContado)} y {bs(nContadoBs)} contados? Después no se puede vender hasta abrirla otra vez.</span>
              <span className="spacer" />
              <button className="btn" onClick={() => setConfirmar(false)}>No</button>
              <button className="btn primary" onClick={async () => {
                const r = await accion(() => cerrarCaja(db, ctx, nContado!, nContadoBs!, notas), 'Caja cerrada');
                if (r) { setContado(''); setContadoBs(''); setNotas(''); setConfirmar(false); }
              }}>Sí, cerrar</button>
            </div>
          )}
        </div>
      )}

      <section className="panel">
        <h2>Cierres anteriores de este equipo</h2>
        {historial && historial.length === 0 && <div className="muted">Todavía no hay cierres.</div>}
        {historial && historial.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Apertura</th><th>Cierre</th><th>Usuario</th><th className="num">Esperado $</th><th className="num">Contado $</th><th className="num">Dif. $</th><th className="num">Dif. Bs</th><th>Notas</th></tr></thead>
              <tbody>
                {historial.slice(0, 30).map((s) => (
                  <tr key={s.id}>
                    <td>{fechaHora(s.abiertaEn)}</td><td>{s.cerradaEn ? fechaHora(s.cerradaEn) : ''}</td><td>{s.usuarioNombre}</td>
                    <td className="num">{usd(s.efectivoEsperado)}</td><td className="num">{usd(s.efectivoContado)}</td>
                    <td className="num"><span className={`badge ${s.diferencia === 0 ? 'good' : (s.diferencia ?? 0) > 0 ? 'warn' : 'bad'}`}>{usd(s.diferencia)}</span></td>
                    <td className="num">{s.diferenciaBs === null || s.diferenciaBs === undefined ? '—' : <span className={`badge ${s.diferenciaBs === 0 ? 'good' : s.diferenciaBs > 0 ? 'warn' : 'bad'}`}>{bs(s.diferenciaBs)}</span>}</td>
                    <td>{s.notas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** Cobrado por cada método (en su moneda y su equivalente en $). */
export function TablaMedios({ porMedio }: { porMedio: Partial<Record<MedioPago, TotalMedio>> }) {
  const filas = MEDIOS.filter((m) => porMedio[m.codigo]);
  if (filas.length === 0) return <div className="muted">Todavía no hay cobros.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Método</th><th className="num">Pagos</th><th className="num">Monto</th><th className="num">Equivale $</th></tr></thead>
        <tbody>{filas.map((m) => {
          const t = porMedio[m.codigo]!;
          return <tr key={m.codigo}><td><span className="badge accent">{m.corto}</span> {m.nombre}</td><td className="num">{t.cantidad}</td><td className="num">{enMoneda(t.montoMoneda, t.moneda)}</td><td className="num">{usd(t.monto)}</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}
