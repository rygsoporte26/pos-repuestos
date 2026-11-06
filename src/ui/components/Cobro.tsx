import { useEffect, useRef, useState } from 'react';
import type { MedioPago, Tasa } from '../../db/types';
import type { DatosCobro } from '../../domain/ventas';
import { DESCUENTO_MAX_POR_DEFECTO, MEDIOS, aBs, aUsd, esDivisa, estadoCobro, medio, saldoEn, type EntradaPago, type EstadoCobro } from '../../domain/pagos';
import { bs, num2, parseNum, round2, usd } from '../../domain/util';
import { Campo, Modal, useAccion, useApp } from './ui';

const NOMBRE_VUELTO: Partial<Record<MedioPago, string>> = { efectivo_usd: 'Efectivo $', efectivo_bs: 'Efectivo Bs', pago_movil: 'Pago móvil' };
type Fila = { id: number; medio: MedioPago; monto: string; referencia: string; auto: boolean };
const txt = (n: number | null) => (n && n > 0 ? String(n).replace('.', ',') : '');

/**
 * Cobro con uno o varios métodos (pago mixto), tasa BCV y vuelto a elección.
 * Lo usan la caja de la tienda y las ventas al mayor (que traen el cliente del pedido).
 */
export function Cobro({ total: subtotal, tasa, onClose, onCobrar, conCliente = true, titulo = 'Cobrar', boton = 'Registrar venta' }: {
  total: number; tasa: Tasa | null; onClose: () => void; onCobrar: (d: DatosCobro) => Promise<void>;
  conCliente?: boolean; titulo?: string; boton?: string;
}) {
  const { negocio } = useApp();
  const t = tasa?.valor ?? null;
  const [filas, setFilas] = useState<Fila[]>([]);
  const [descTxt, setDescTxt] = useState('');
  const [descTipo, setDescTipo] = useState<'%' | '$'>('%');
  // Descuento por pagar en divisa: lo escribe el vendedor, hasta el tope del administrador,
  // y solo si todos los pagos son en divisa (efectivo $, Binance, USDT).
  const maxPct = negocio.descuentoMaxDivisa ?? DESCUENTO_MAX_POR_DEFECTO;
  const todoDivisa = filas.length > 0 && filas.every((f) => esDivisa(f.medio));
  const maxUsd = round2((subtotal * maxPct) / 100);
  const nDesc = parseNum(descTxt);
  const descuento = todoDivisa && nDesc !== null && nDesc > 0 ? round2(descTipo === '%' ? (subtotal * nDesc) / 100 : nDesc) : 0;
  const descMalo = descuento > maxUsd + 0.001 || (nDesc !== null && nDesc < 0);
  const total = descMalo ? subtotal : round2(subtotal - descuento);
  const [vuelto, setVuelto] = useState<MedioPago | null>(null);
  const [nombre, setNombre] = useState('');
  const [tel, setTel] = useState('');
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const sig = useRef(1);

  const entradas: EntradaPago[] = filas.map((f) => ({ medio: f.medio, montoMoneda: parseNum(f.monto) ?? 0, referencia: f.referencia }));
  let est: EstadoCobro = { pagado: 0, falta: total, exceso: 0 };
  try { est = estadoCobro(total, entradas.filter((e) => e.montoMoneda > 0), t); } catch { /* falta tasa */ }
  const faltaRef = filas.find((f) => medio(f.medio).referencia && (parseNum(f.monto) ?? 0) > 0 && !f.referencia.trim());
  const vueltoElegido = vuelto ?? (filas.some((f) => f.medio === 'efectivo_usd') ? 'efectivo_usd' : 'efectivo_bs');
  const vueltoPosible = est.exceso === 0 || medio(vueltoElegido).moneda === 'USD' || !!t;
  const ok = filas.length > 0 && est.falta === 0 && !faltaRef && vueltoPosible && !descMalo;

  // Si hay un solo pago y nadie le tocó el monto, se ajusta solo al total con descuento.
  useEffect(() => {
    setFilas((fs) => (fs.length === 1 && fs[0].auto ? [{ ...fs[0], monto: txt(saldoEn(total, fs[0].medio, t)) }] : fs));
  }, [total, t]);

  function agregar(m: MedioPago) {
    const monto = saldoEn(est.falta, m, t);
    setFilas((fs) => [...fs, { id: sig.current++, medio: m, monto: txt(monto), referencia: '', auto: fs.length === 0 }]);
    setTimeout(() => document.getElementById(`monto-${sig.current - 1}`)?.focus(), 0);
  }
  const cambiar = (id: number, c: Partial<Fila>) => setFilas((fs) => fs.map((f) => (f.id === id ? { ...f, ...c } : f)));

  async function confirmar(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ok || guardando) return;
    setGuardando(true);
    await accion(() => onCobrar({ pagos: entradas, vuelto: est.exceso > 0 ? { medio: vueltoElegido } : undefined, tasa: t, descuento: descMalo ? 0 : descuento, clienteNombre: nombre, clienteTelefono: tel }));
    setGuardando(false);
  }

  return (
    <Modal titulo={titulo} onClose={onClose} wide>
      <form onSubmit={confirmar} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="total-box">
          <span className="label">Total</span>
          <span style={{ textAlign: 'right' }}>
            <span className="amount">{usd(total)}</span>
            {descuento > 0 && !descMalo && <div className="muted">Subtotal {usd(subtotal)} · descuento −{usd(descuento)}</div>}
            <div className="muted">{t ? `${bs(aBs(total, t))} · tasa ${num2(t)}` : 'Sin tasa BCV: solo se puede cobrar en $'}</div>
          </span>
        </div>
        <div className="medios" role="group" aria-label="Agregar pago">
          {MEDIOS.map((m) => (
            <button type="button" key={m.codigo} className="btn" disabled={m.moneda === 'VES' && !t} onClick={() => agregar(m.codigo)}
              title={m.moneda === 'VES' && !t ? 'Falta la tasa BCV del día' : ''}>
              <strong>{m.corto}</strong> <span className="small">{m.nombre}</span>
            </button>
          ))}
        </div>
        {filas.length === 0 && <div className="muted">Elige el método de pago. Para pago mixto, agrega varios.</div>}
        {filas.map((f) => {
          const m = medio(f.medio);
          const n = parseNum(f.monto);
          let eq: number | null = null;
          try { eq = n === null ? null : aUsd(n, m.moneda, t); } catch { eq = null; }
          return (
            <div className="pago-fila" key={f.id}>
              <span className="badge accent">{m.corto}</span>
              <strong className="pago-nombre">{m.nombre}</strong>
              <label className="field"><span>Monto en {m.moneda === 'USD' ? '$' : 'Bs'}</span>
                <input id={`monto-${f.id}`} className={`input${n === null || n <= 0 ? ' invalid' : ''}`} inputMode="decimal" value={f.monto}
                  onChange={(e) => cambiar(f.id, { monto: e.target.value, auto: false })} onFocus={(e) => e.target.select()} />
              </label>
              {m.referencia && (
                <label className="field"><span>Referencia</span>
                  <input id={`ref-${f.id}`} className={`input${f.referencia.trim() ? '' : ' invalid'}`} inputMode="numeric" value={f.referencia}
                    onChange={(e) => cambiar(f.id, { referencia: e.target.value })} placeholder="Obligatoria" />
                </label>
              )}
              <span className="num muted small">{m.moneda === 'VES' && eq !== null ? `= ${usd(eq)}` : ''}</span>
              <button type="button" className="x" aria-label={`Quitar ${m.nombre}`} onClick={() => setFilas((fs) => fs.filter((x) => x.id !== f.id))}>×</button>
            </div>
          );
        })}
        {maxPct > 0 && todoDivisa && (
          <div className="pago-fila" aria-label="Descuento por pago en divisa">
            <span className="badge good">−</span>
            <strong className="pago-nombre">Descuento por pago en divisa <span className="muted small">(máx. {maxPct}% = {usd(maxUsd)})</span></strong>
            <label className="field"><span>Descuento</span>
              <input id="descuento" className={`input${descMalo ? ' invalid' : ''}`} inputMode="decimal" value={descTxt} placeholder="0" onChange={(e) => setDescTxt(e.target.value)} />
            </label>
            <label className="field"><span>En</span>
              <select id="descuento-tipo" className="input" value={descTipo} onChange={(e) => setDescTipo(e.target.value as '%' | '$')}><option value="%">%</option><option value="$">$</option></select>
            </label>
            <span className="num muted small">{descuento > 0 && !descMalo ? `−${usd(descuento)}` : ''}</span>
          </div>
        )}
        {descMalo && <div className="alert bad">El descuento máximo por pago en divisa es {maxPct}% ({usd(maxUsd)}).</div>}
        {maxPct > 0 && !todoDivisa && filas.length > 0 && filas.some((f) => esDivisa(f.medio)) && (
          <div className="muted small">El descuento por pago en divisa solo aplica cuando todo se paga con efectivo $, Binance o USDT.</div>
        )}
        {filas.length > 0 && est.falta > 0 && (
          <div className="alert warn">Falta <strong>{usd(est.falta)}</strong>{t ? <> ({bs(aBs(est.falta, t))})</> : null}. Agrega otro pago o corrige el monto.</div>
        )}
        {est.exceso > 0 && (
          <div className="alert info" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Vuelto: <strong>{usd(est.exceso)}</strong>{t ? <> = <strong>{bs(aBs(est.exceso, t))}</strong></> : null}. ¿Cómo se entrega?</span>
            <div className="row" role="radiogroup" aria-label="Vuelto">
              {(['efectivo_usd', 'efectivo_bs', 'pago_movil'] as MedioPago[]).map((m) => (
                <label key={m} className="check">
                  <input type="radio" name="vuelto" checked={vueltoElegido === m} disabled={medio(m).moneda === 'VES' && !t} onChange={() => setVuelto(m)} />
                  {NOMBRE_VUELTO[m]} ({medio(m).moneda === 'USD' ? usd(est.exceso) : t ? bs(aBs(est.exceso, t)) : '—'})
                </label>
              ))}
            </div>
          </div>
        )}
        {est.falta === 0 && est.exceso === 0 && filas.length > 0 && !faltaRef && <div className="alert good">Pago completo.</div>}
        {faltaRef && <div className="alert bad">Falta la referencia de {medio(faltaRef.medio).nombre}.</div>}
        {conCliente && (
          <details>
            <summary className="muted" style={{ cursor: 'pointer' }}>Cliente (opcional)</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <Campo label="Nombre"><input id="cliente-nombre" className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
              <Campo label="Teléfono"><input id="cliente-tel" className="input" inputMode="tel" value={tel} onChange={(e) => setTel(e.target.value)} /></Campo>
            </div>
          </details>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Volver</button>
          <button type="submit" className="btn primary big" disabled={!ok || guardando}>{boton}</button>
        </div>
      </form>
    </Modal>
  );
}
