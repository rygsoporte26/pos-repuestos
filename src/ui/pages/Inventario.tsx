import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Producto, TipoMovimiento } from '../../db/types';
import { registrarConteo, registrarEntrada } from '../../domain/inventario';
import { buscarProductos } from '../../domain/buscar';
import { fechaHora, normalizar, parseEntero, parseNum, usd } from '../../domain/util';
import { Campo, useAccion, useApp, useToast } from '../components/ui';
import { claseStock, useProductos, useStock } from '../hooks';

type Tab = 'conteo' | 'entrada' | 'movimientos';

export function Inventario() {
  const [tab, setTab] = useState<Tab>('conteo');
  return (
    <>
      <h1>Inventario</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'conteo'} onClick={() => setTab('conteo')}>Conteo físico</button>
        <button role="tab" aria-selected={tab === 'entrada'} onClick={() => setTab('entrada')}>Entrada de mercancía</button>
        <button role="tab" aria-selected={tab === 'movimientos'} onClick={() => setTab('movimientos')}>Movimientos</button>
      </div>
      {tab === 'conteo' && <Conteo />}
      {tab === 'entrada' && <Entrada />}
      {tab === 'movimientos' && <Movimientos />}
    </>
  );
}

function Conteo() {
  const { ctx } = useApp();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const familias = useMemo(() => [...new Set(productos.map((p) => p.familia).filter(Boolean) as string[])].sort(), [productos]);
  const [familia, setFamilia] = useState('');
  const [q, setQ] = useState('');
  const lista = useMemo(() => {
    const w = normalizar(q).split(' ').filter(Boolean);
    if (!familia && !w.length) return [];
    return productos.filter((p) => p.activo && (!familia || p.familia === familia) && w.every((x) => p.busqueda.includes(x)))
      .sort((a, b) => a.descripcion.localeCompare(b.descripcion)).slice(0, 200);
  }, [productos, familia, q]);
  return (
    <div className="panel">
      <div className="muted small">Cuenta estante por estante: elige una familia, escribe las piezas que hay y pulsa Enter. La primera vez queda como inventario inicial; después, como ajuste por la diferencia. Cuenta en piezas, no en bultos.</div>
      <div className="row">
        <Campo label="Familia">
          <select id="conteo-familia" className="input" value={familia} onChange={(e) => setFamilia(e.target.value)}>
            <option value="">Elegir familia…</option>
            {familias.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Campo>
        <Campo label="o buscar"><input id="conteo-buscar" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, nombre o moto" /></Campo>
      </div>
      {lista.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Código</th><th className="desc">Descripción</th><th>Presentación</th><th className="num">En sistema</th><th className="num">Contado (pzs)</th><th></th></tr></thead>
            <tbody>{lista.map((p) => <FilaConteo key={p.id} p={p} stock={stock.get(p.id) ?? 0} />)}</tbody>
          </table>
        </div>
      )}
      {(familia || q) && lista.length === 0 && <div className="muted">No hay productos con ese filtro.</div>}
    </div>
  );
}

function FilaConteo({ p, stock }: { p: Producto; stock: number }) {
  const { ctx } = useApp();
  const accion = useAccion();
  const avisar = useToast();
  const [v, setV] = useState('');
  const n = parseEntero(v);
  async function guardar() {
    if (n === null || n < 0) return;
    const diff = await accion(() => registrarConteo(db, ctx, p.id, n));
    if (diff !== undefined) {
      avisar(diff === 0 ? `${p.codigo}: el conteo coincide` : `${p.codigo}: ${diff > 0 ? '+' : ''}${diff} piezas`);
      setV('');
    }
  }
  return (
    <tr>
      <td className="mono">{p.codigo}</td>
      <td className="desc">{p.descripcion}<div className="muted small">{p.marcaAplica}</div></td>
      <td className="mono small">{p.presentacion}</td>
      <td className={`num ${claseStock(stock, p.stockMinimo)}`}>{stock}</td>
      <td className="num">
        <input className={`input cell qty${v && (n === null || n < 0) ? ' invalid' : ''}`} aria-label={`Contado ${p.codigo}`} inputMode="numeric"
          value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && guardar()} />
      </td>
      <td>{v !== '' && <button className="btn primary" disabled={n === null || n < 0} onClick={guardar}>Guardar</button>}</td>
    </tr>
  );
}

function Entrada() {
  const { ctx } = useApp();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const accion = useAccion();
  const [q, setQ] = useState('');
  const [p, setP] = useState<Producto | null>(null);
  const [bultos, setBultos] = useState('');
  const [piezas, setPiezas] = useState('');
  const [costo, setCosto] = useState('');
  const [nota, setNota] = useState('');
  const res = useMemo(() => buscarProductos(productos, q, 12), [productos, q]);
  const total = (parseEntero(bultos) ?? 0) * (p?.unidadesBulto ?? 0) + (parseEntero(piezas) ?? 0);
  const nCosto = parseNum(costo);

  return (
    <div className="panel" style={{ maxWidth: 760 }}>
      <div className="muted small">Registra la mercancía que llega del importador. Se suma al stock de esta sede.</div>
      {!p ? (
        <>
          <Campo label="Producto"><input id="entrada-buscar" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, nombre o moto" autoFocus /></Campo>
          {res.length > 0 && (
            <div className="results">
              {res.map((x) => (
                <button key={x.id} className="result" onClick={() => { setP(x); setCosto(String(x.costo).replace('.', ',')); }}>
                  <span className="code">{x.codigo}</span><span className="name">{x.descripcion}</span>
                  <span className="prices">{usd(x.costo)}</span><span className="meta">{x.presentacion ?? ''} · Stock {stock.get(x.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <form style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={async (e) => {
          e.preventDefault();
          const ok = await accion(() => registrarEntrada(db, ctx, p.id, total, { costo: nCosto, nota, actualizarCosto: true }), `Entrada registrada: +${total} piezas`);
          if (ok !== undefined) { setP(null); setQ(''); setBultos(''); setPiezas(''); setNota(''); }
        }}>
          <div className="row center">
            <div><span className="mono">{p.codigo}</span> · <strong>{p.descripcion}</strong><div className="muted small">Stock actual {stock.get(p.id) ?? 0} · {p.presentacion ?? 'sin presentación'}</div></div>
            <span className="spacer" /><button type="button" className="btn ghost" onClick={() => setP(null)}>Cambiar producto</button>
          </div>
          <div className="row">
            {p.unidadesBulto && <Campo label={`Bultos (de ${p.unidadesBulto})`}><input id="entrada-bultos" className="input" inputMode="numeric" value={bultos} onChange={(e) => setBultos(e.target.value)} /></Campo>}
            <Campo label="Piezas sueltas"><input id="entrada-piezas" className="input" inputMode="numeric" value={piezas} onChange={(e) => setPiezas(e.target.value)} /></Campo>
            <Campo label="Costo por pieza USD"><input id="entrada-costo" className="input" inputMode="decimal" value={costo} onChange={(e) => setCosto(e.target.value)} /></Campo>
          </div>
          <Campo label="Nota (ej. factura del importador)"><input id="entrada-nota" className="input" value={nota} onChange={(e) => setNota(e.target.value)} /></Campo>
          {nCosto !== null && nCosto !== p.costo && <div className="alert warn">El costo cambia de {usd(p.costo)} a {usd(nCosto)}. Revisa si hay que ajustar los precios de venta.</div>}
          <div className="row center"><strong>Total a sumar: {total} piezas</strong><span className="spacer" /><button className="btn primary" type="submit" disabled={total <= 0}>Registrar entrada</button></div>
        </form>
      )}
    </div>
  );
}

const NOMBRE_TIPO: Record<TipoMovimiento, string> = {
  inicial: 'Inicial', compra: 'Entrada', venta: 'Venta', anulacion: 'Anulación', ajuste: 'Ajuste',
  traslado_salida: 'Traslado sale', traslado_entrada: 'Traslado entra', devolucion: 'Devolución',
};

function Movimientos() {
  const productos = useProductos();
  const porId = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  const movs = useLiveQuery(() => db.movimientos.orderBy('creadoEn').reverse().limit(200).toArray(), []) ?? [];
  return (
    <div className="panel">
      <div className="muted small">Últimos 200 movimientos. El stock de cada producto es la suma de todos sus movimientos.</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Código</th><th className="desc">Producto</th><th className="num">Piezas</th><th>Usuario</th><th>Nota</th></tr></thead>
          <tbody>
            {movs.map((m) => {
              const p = porId.get(m.productoId);
              return (
                <tr key={m.id}>
                  <td className="small">{fechaHora(m.creadoEn)}</td><td><span className="badge">{NOMBRE_TIPO[m.tipo]}</span></td>
                  <td className="mono">{p?.codigo}</td><td className="desc">{p?.descripcion}</td>
                  <td className="num" style={{ color: m.cantidad < 0 ? 'var(--bad)' : 'var(--good)' }}>{m.cantidad > 0 ? '+' : ''}{m.cantidad}</td>
                  <td className="small">{m.usuarioNombre}</td><td className="small">{m.nota}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {movs.length === 0 && <div className="muted">Todavía no hay movimientos.</div>}
    </div>
  );
}
