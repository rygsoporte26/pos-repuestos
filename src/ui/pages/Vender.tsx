import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { MedioPago, Producto, Tasa, Venta } from '../../db/types';
import { buscarProductos } from '../../domain/buscar';
import { calcularCarrito, registrarVenta, type DatosCobro, type LineaCarrito } from '../../domain/ventas';
import { MEDIOS, aBs, aUsd, estadoCobro, medio, saldoEn, type EntradaPago, type EstadoCobro } from '../../domain/pagos';
import { tasaDeHoy } from '../../domain/tasa';
import { puede } from '../../domain/contexto';
import { precioAplicable } from '../../domain/precios';
import { sesionAbierta } from '../../domain/caja';
import { bs, enMoneda, num2, parseEntero, parseNum, usd } from '../../domain/util';
import { Campo, Modal, useAccion, useApp, useToast } from '../components/ui';
import { Ticket } from '../components/Ticket';
import { claseStock, useProductos, useStock, useTasa } from '../hooks';

export function Vender() {
  const { ctx, negocio, irA } = useApp();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const tasa = useTasa();
  const sesion = useLiveQuery(async () => (await sesionAbierta(db, ctx.dispositivoId)) ?? null, [ctx.dispositivoId]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [carrito, setCarrito] = useState<LineaCarrito[]>([]);
  const [cobrando, setCobrando] = useState(false);
  const [ticket, setTicket] = useState<Venta | null>(null);
  const busca = useRef<HTMLInputElement>(null);
  const avisar = useToast();

  const resultados = useMemo(() => buscarProductos(productos, q, 30), [productos, q]);
  useEffect(() => setSel(0), [q]);

  // El carrito guarda el producto del momento; si el admin cambia un precio, se refresca.
  const porId = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  const lineas = carrito.map((l) => ({ ...l, producto: porId.get(l.producto.id) ?? l.producto }));
  let calc: ReturnType<typeof calcularCarrito> | null = null;
  let errorCarrito: string | null = null;
  try { calc = calcularCarrito(lineas); } catch (e) { errorCarrito = (e as Error).message; }

  function agregar(p: Producto) {
    if (!precioAplicable(p, 1)) {
      avisar(`"${p.descripcion}" no tiene precio todavía. El administrador debe cargarlo en Productos.`, true);
      return;
    }
    setCarrito((c) => {
      const i = c.findIndex((l) => l.producto.id === p.id);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, cantidad: l.cantidad + 1 } : l));
      return [...c, { producto: p, cantidad: 1 }];
    });
    setQ('');
    busca.current?.focus();
  }

  const setCant = (id: string, cantidad: number) =>
    setCarrito((c) => (cantidad <= 0 ? c.filter((l) => l.producto.id !== id) : c.map((l) => (l.producto.id === id ? { ...l, cantidad } : l))));

  function teclas(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, resultados.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter' && resultados[sel]) { e.preventDefault(); agregar(resultados[sel]); }
  }

  useEffect(() => {
    const f2 = (e: KeyboardEvent) => {
      if (e.key === 'F2' && carrito.length && calc && sesion) { e.preventDefault(); setCobrando(true); }
    };
    window.addEventListener('keydown', f2);
    return () => window.removeEventListener('keydown', f2);
  });

  if (sesion === undefined) return <div className="muted">Cargando…</div>;
  if (sesion === null && !ticket) {
    return (
      <div className="panel" style={{ maxWidth: 560 }}>
        <h2>Caja cerrada</h2>
        <p className="muted" style={{ margin: 0 }}>Para vender, primero abre la caja de este equipo con el efectivo base.</p>
        <div><button className="btn primary big" onClick={() => irA('caja')}>Abrir caja</button></div>
      </div>
    );
  }

  return (
    <div className="grid-vender">
      <section className="panel" aria-label="Buscar productos">
        <input
          ref={busca} autoFocus className="input search" id="buscar" placeholder="Código, nombre o moto (ej. pastilla jaguar)"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={teclas} autoComplete="off"
        />
        {q && resultados.length === 0 && <div className="muted">No hay productos que coincidan con “{q}”.</div>}
        {!q && <div className="muted small">Escribe para buscar. ↑ ↓ para moverte, Enter para agregar. F2 para cobrar.</div>}
        {resultados.length > 0 && (
          <div className="results">
            {resultados.map((p, i) => {
              const st = stock.get(p.id) ?? 0;
              const sinPrecio = p.precioDetal === null;
              return (
                <button key={p.id} className={`result${i === sel ? ' sel' : ''}${sinPrecio ? ' noprice' : ''}`} onClick={() => agregar(p)}>
                  <span className="code">{p.codigo}</span>
                  <span className="name">{p.descripcion}</span>
                  <span className="prices">
                    {sinPrecio ? <span className="badge warn">Sin precio</span> : <strong>{usd(p.precioDetal)}</strong>}
                    {p.precioMayor !== null && <div className="m">{usd(p.precioMayor)} desde {p.cantMinMayor}</div>}
                  </span>
                  <span className="meta">
                    {p.marcaAplica ?? '—'} · {p.familia ?? 'Sin familia'} · Stock <span className={claseStock(st, p.stockMinimo)}>{st}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel" aria-label="Venta actual">
        <div className="row center">
          <h2>Venta</h2>
          <span className="spacer" />
          {carrito.length > 0 && <button className="btn ghost" onClick={() => setCarrito([])}>Vaciar</button>}
        </div>
        {carrito.length === 0 && <div className="muted">Agrega productos desde la búsqueda.</div>}
        {calc?.lineas.map((l) => {
          const st = stock.get(l.producto.id) ?? 0;
          const faltan = l.producto.precioMayor !== null && l.producto.cantMinMayor !== null && l.tipo === 'detal'
            ? l.producto.cantMinMayor - l.cantidad : null;
          return (
            <div className="cart-line" key={l.producto.id}>
              <div className="name">{l.producto.descripcion}</div>
              <div className="qty-ctl">
                <button aria-label="Quitar uno" onClick={() => setCant(l.producto.id, l.cantidad - 1)}>−</button>
                <input
                  className="input cell qty" aria-label="Cantidad" inputMode="numeric" value={l.cantidad}
                  onChange={(e) => { const n = parseEntero(e.target.value); if (n !== null && n >= 0) setCant(l.producto.id, n); }}
                />
                <button aria-label="Agregar uno" onClick={() => setCant(l.producto.id, l.cantidad + 1)}>+</button>
              </div>
              <div className="num">{usd(l.precio)}{l.tipo === 'mayor' && <div><span className="badge mayor">Mayor</span></div>}</div>
              <div className="num"><strong>{usd(l.total)}</strong></div>
              <div className="sub">
                <span className="mono">{l.producto.codigo}</span> · Stock {st}
                {st - l.cantidad < 0 && <span className="stock-neg"> · quedaría en {st - l.cantidad}</span>}
                {faltan !== null && faltan > 0 && <span className="hint-mayor"> · faltan {faltan} para precio mayor</span>}
              </div>
            </div>
          );
        })}
        {errorCarrito && <div className="alert bad">{errorCarrito}</div>}
        <div className="total-box">
          <span className="label">Total</span>
          <span style={{ textAlign: 'right' }}>
            <span className="amount">{usd(calc?.total ?? 0)}</span>
            {tasa && <div className="muted">{bs(aBs(calc?.total ?? 0, tasa.valor))}</div>}
          </span>
        </div>
        {tasa !== undefined && !tasaDeHoy(tasa) && (
          <div className="alert warn row center">
            <span>{tasa ? `La tasa BCV cargada es del ${tasa.fecha} (${num2(tasa.valor)}).` : 'No hay tasa BCV cargada: solo se puede cobrar en $.'} {puede(ctx.usuario.rol, 'ajustes') ? '' : 'Avisa al administrador.'}</span>
            {puede(ctx.usuario.rol, 'ajustes') && <button className="btn" onClick={() => irA('ajustes')}>Cargar tasa de hoy</button>}
          </div>
        )}
        <button className="btn primary big" disabled={!carrito.length || !calc} onClick={() => setCobrando(true)}>Cobrar (F2)</button>
      </section>

      {cobrando && calc && (
        <Cobro
          total={calc.total}
          tasa={tasa ?? null}
          onClose={() => setCobrando(false)}
          onCobrar={async (datos) => {
            const v = await registrarVenta(db, ctx, lineas, datos);
            setCarrito([]);
            setCobrando(false);
            setTicket(v);
          }}
        />
      )}
      {ticket && (
        <Modal titulo={`Venta ${ticket.numero}`} onClose={() => { setTicket(null); busca.current?.focus(); }}>
          <div className="alert good">Venta registrada.{ticket.pagos.filter((p) => p.tipo === 'vuelto').map((p) => <span key={p.id}> Vuelto: <strong>{enMoneda(-p.montoMoneda, p.moneda)}</strong> en {medio(p.medio).nombre.toLowerCase()}.</span>)}</div>
          <Ticket venta={ticket} negocio={negocio} />
          <div className="row">
            <span className="spacer" />
            {import.meta.env.MODE !== 'demo' && <button className="btn" onClick={() => window.print()}>Imprimir</button>}
            <button className="btn primary" autoFocus onClick={() => { setTicket(null); busca.current?.focus(); }}>Nueva venta</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const NOMBRE_VUELTO: Partial<Record<MedioPago, string>> = { efectivo_usd: 'Efectivo $', efectivo_bs: 'Efectivo Bs', pago_movil: 'Pago móvil' };
type Fila = { id: number; medio: MedioPago; monto: string; referencia: string };

/** Cobro con uno o varios métodos (pago mixto), tasa BCV y vuelto a elección. */
function Cobro({ total, tasa, onClose, onCobrar }: { total: number; tasa: Tasa | null; onClose: () => void; onCobrar: (d: DatosCobro) => Promise<void> }) {
  const t = tasa?.valor ?? null;
  const [filas, setFilas] = useState<Fila[]>([]);
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
  const ok = filas.length > 0 && est.falta === 0 && !faltaRef && vueltoPosible;

  function agregar(m: MedioPago) {
    const monto = saldoEn(est.falta, m, t);
    setFilas((fs) => [...fs, { id: sig.current++, medio: m, monto: monto && monto > 0 ? String(monto).replace('.', ',') : '', referencia: '' }]);
    setTimeout(() => document.getElementById(`monto-${sig.current - 1}`)?.focus(), 0);
  }
  const cambiar = (id: number, c: Partial<Fila>) => setFilas((fs) => fs.map((f) => (f.id === id ? { ...f, ...c } : f)));

  async function confirmar(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ok || guardando) return;
    setGuardando(true);
    await accion(() => onCobrar({ pagos: entradas, vuelto: est.exceso > 0 ? { medio: vueltoElegido } : undefined, tasa: t, clienteNombre: nombre, clienteTelefono: tel }));
    setGuardando(false);
  }

  return (
    <Modal titulo="Cobrar" onClose={onClose} wide>
      <form onSubmit={confirmar} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="total-box">
          <span className="label">Total</span>
          <span style={{ textAlign: 'right' }}>
            <span className="amount">{usd(total)}</span>
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
                  onChange={(e) => cambiar(f.id, { monto: e.target.value })} onFocus={(e) => e.target.select()} />
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
        <details>
          <summary className="muted" style={{ cursor: 'pointer' }}>Cliente (opcional)</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <Campo label="Nombre"><input id="cliente-nombre" className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
            <Campo label="Teléfono"><input id="cliente-tel" className="input" inputMode="tel" value={tel} onChange={(e) => setTel(e.target.value)} /></Campo>
          </div>
        </details>
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Volver</button>
          <button type="submit" className="btn primary big" disabled={!ok || guardando}>Registrar venta</button>
        </div>
      </form>
    </Modal>
  );
}
