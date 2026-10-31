import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Producto, Venta } from '../../db/types';
import { buscarProductos } from '../../domain/buscar';
import { calcularCarrito, registrarVenta, type LineaCarrito } from '../../domain/ventas';
import { aBs, medio } from '../../domain/pagos';
import { tasaDeHoy } from '../../domain/tasa';
import { puede } from '../../domain/contexto';
import { sesionAbierta } from '../../domain/caja';
import { bs, enMoneda, num2, parseEntero, usd } from '../../domain/util';
import { Modal, useApp, useToast } from '../components/ui';
import { Ticket } from '../components/Ticket';
import { Cobro } from '../components/Cobro';
import { claseStock, useApartados, useProductos, useStock, useTasa } from '../hooks';

export function Vender() {
  const { ctx, negocio, irA } = useApp();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const apart = useApartados(ctx.sedeId);
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
    if (p.precioDetal === null || p.precioDetal <= 0) {
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
              const ap = apart.get(p.id) ?? 0;
              const sinPrecio = p.precioDetal === null;
              return (
                <button key={p.id} className={`result${i === sel ? ' sel' : ''}${sinPrecio ? ' noprice' : ''}`} onClick={() => agregar(p)}>
                  <span className="code">{p.codigo}</span>
                  <span className="name">{p.descripcion}</span>
                  <span className="prices">
                    {sinPrecio ? <span className="badge warn">Sin precio</span> : <strong>{usd(p.precioDetal)}</strong>}
                    {p.precioMayor !== null && <div className="m" title="Las ventas al mayor las hace el administrador o el supervisor">Mayor {usd(p.precioMayor)}</div>}
                  </span>
                  <span className="meta">
                    {p.marcaAplica ?? '—'} · {p.familia ?? 'Sin categoría'} · {ap > 0
                      ? <>Disponible <span className={claseStock(st - ap, p.stockMinimo)}>{st - ap}</span> ({ap} apartadas al mayor)</>
                      : <>Stock <span className={claseStock(st, p.stockMinimo)}>{st}</span></>}
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
          const ap = apart.get(l.producto.id) ?? 0;
          const st = (stock.get(l.producto.id) ?? 0) - ap; // disponible para la tienda
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
              <div className="num">{usd(l.precio)}</div>
              <div className="num"><strong>{usd(l.total)}</strong></div>
              <div className="sub">
                <span className="mono">{l.producto.codigo}</span> · {ap > 0 ? `Disponible ${st} (${ap} apartadas al mayor)` : `Stock ${st}`}
                {st - l.cantidad < 0 && <span className="stock-neg"> · quedaría en {st - l.cantidad}</span>}
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
