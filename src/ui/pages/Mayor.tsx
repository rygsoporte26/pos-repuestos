import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { PedidoMayor, Producto, Venta } from '../../db/types';
import { buscarProductos } from '../../domain/buscar';
import { cancelarPedido, guardarPedido, lineasDePedido, venderMayor } from '../../domain/mayor';
import { calcularCarrito, precioMayorSugerido, type LineaCarrito } from '../../domain/ventas';
import { enMoneda, fechaHora, diaLocal, parseEntero, parseNum, round2, usd } from '../../domain/util';
import { medio, normalizarPago } from '../../domain/pagos';
import { Campo, Modal, useAccion, useApp } from '../components/ui';
import { Cobro } from '../components/Cobro';
import { Ticket } from '../components/Ticket';
import { useApartados, useProductos, useStock, useTasa } from '../hooks';
import { DetalleVenta } from './Ventas';

type Tab = 'pedido' | 'pendientes' | 'ventas';

export function Mayor() {
  const { ctx } = useApp();
  const [tab, setTab] = useState<Tab>('pedido');
  const [editando, setEditando] = useState<PedidoMayor | null>(null);
  const pendientes = useLiveQuery(() => db.pedidos.where('estado').equals('pendiente').filter((p) => p.sedeId === ctx.sedeId).sortBy('creadoEn'), [ctx.sedeId]) ?? [];
  const abrir = (p: PedidoMayor | null) => { setEditando(p); setTab('pedido'); };
  return (
    <>
      <h1>Ventas al mayor</h1>
      <div className="muted small" style={{ maxWidth: 900 }}>
        Las manejan el administrador y el supervisor, sin caja. Un pedido pendiente <strong>aparta</strong> las piezas: la tienda deja de verlas como disponibles.
        Al despacharlo se cobra completo y sale del inventario. La mercancía que llega se registra igual que siempre en Inventario → Entrada de mercancía.
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pedido'} onClick={() => setTab('pedido')}>{editando ? `Pedido ${editando.numero}` : 'Nuevo pedido'}</button>
        <button role="tab" aria-selected={tab === 'pendientes'} onClick={() => setTab('pendientes')}>Pendientes ({pendientes.length})</button>
        <button role="tab" aria-selected={tab === 'ventas'} onClick={() => setTab('ventas')}>Ventas al mayor</button>
      </div>
      {tab === 'pedido' && <FormPedido key={editando?.id ?? 'nuevo'} pedido={editando} onListo={(ir) => { setEditando(null); setTab(ir); }} />}
      {tab === 'pendientes' && <Pendientes pedidos={pendientes} onAbrir={abrir} />}
      {tab === 'ventas' && <VentasMayor />}
    </>
  );
}

function FormPedido({ pedido, onListo }: { pedido: PedidoMayor | null; onListo: (ir: Tab) => void }) {
  const { ctx, negocio } = useApp();
  const accion = useAccion();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const apart = useApartados(ctx.sedeId, pedido?.id); // lo apartado por OTROS pedidos
  const tasa = useTasa();
  const porId = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  const [cliente, setCliente] = useState(pedido?.clienteNombre ?? '');
  const [tel, setTel] = useState(pedido?.clienteTelefono ?? '');
  const [nota, setNota] = useState(pedido?.nota ?? '');
  const [lineas, setLineas] = useState<{ producto: Producto; cantidad: string; precio: string }[]>(() => {
    if (!pedido) return [];
    try { return lineasDePedido(pedido, porId).map((l) => ({ producto: l.producto, cantidad: String(l.cantidad), precio: String(l.precio).replace('.', ',') })); } catch { return []; }
  });
  const [q, setQ] = useState('');
  const [cobrando, setCobrando] = useState(false);
  const [ticket, setTicket] = useState<Venta | null>(null);
  const res = useMemo(() => buscarProductos(productos, q, 10), [productos, q]);

  // Si el pedido llegó antes que el catálogo en este equipo, se arma cuando aparecen los productos.
  if (pedido && lineas.length === 0 && pedido.items.length > 0 && porId.size > 0) {
    try { setLineas(lineasDePedido(pedido, porId).map((l) => ({ producto: l.producto, cantidad: String(l.cantidad), precio: String(l.precio).replace('.', ',') }))); } catch { /* producto borrado */ }
  }

  const carrito: LineaCarrito[] = lineas.map((l) => ({ producto: porId.get(l.producto.id) ?? l.producto, cantidad: parseEntero(l.cantidad) ?? 0, precio: parseNum(l.precio) ?? 0 }));
  let total = 0; let error: string | null = null;
  try {
    if (carrito.some((l) => l.cantidad <= 0)) throw new Error('Revisa las cantidades: deben ser enteros mayores que 0');
    if (carrito.some((l) => !(l.precio! > 0))) throw new Error('Revisa los precios: deben ser mayores que 0');
    total = carrito.length ? calcularCarrito(carrito, 'mayor').total : 0;
  } catch (e) { error = (e as Error).message; }
  const listo = cliente.trim() !== '' && carrito.length > 0 && !error;
  const datos = () => ({ clienteNombre: cliente, clienteTelefono: tel, nota, lineas: carrito });

  function agregar(p: Producto) {
    if (!lineas.some((l) => l.producto.id === p.id)) {
      const sug = precioMayorSugerido(p);
      setLineas((ls) => [...ls, { producto: p, cantidad: String(p.cantMinMayor ?? 1), precio: sug ? String(sug).replace('.', ',') : '' }]);
    }
    setQ('');
  }
  const cambiar = (id: string, c: Partial<{ cantidad: string; precio: string }>) => setLineas((ls) => ls.map((l) => (l.producto.id === id ? { ...l, ...c } : l)));

  return (
    <div className="panel">
      {pedido && <div className="alert info">Pedido <strong>{pedido.numero}</strong> pendiente, creado el {fechaHora(pedido.creadoEn)} por {pedido.creadoPor}. Puedes cambiarlo, despacharlo o volver sin guardar.</div>}
      <div className="row">
        <Campo label="Cliente (obligatorio)"><input id="mayor-cliente" className="input" value={cliente} onChange={(e) => setCliente(e.target.value)} placeholder="Nombre o negocio" /></Campo>
        <Campo label="Teléfono"><input id="mayor-tel" className="input" inputMode="tel" value={tel} onChange={(e) => setTel(e.target.value)} /></Campo>
        <Campo label="Nota"><input id="mayor-nota" className="input" value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Ej. entrega el viernes" /></Campo>
      </div>
      <Campo label="Agregar producto"><input id="mayor-buscar" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, nombre, moto o proveedor" autoComplete="off" /></Campo>
      {res.length > 0 && (
        <div className="results">
          {res.map((p) => {
            const st = stock.get(p.id) ?? 0; const ap = apart.get(p.id) ?? 0;
            return (
              <button key={p.id} className="result" onClick={() => agregar(p)}>
                <span className="code">{p.codigo}</span><span className="name">{p.descripcion}</span>
                <span className="prices"><strong>{usd(precioMayorSugerido(p))}</strong>{p.precioMayor === null && <div className="m">sin precio mayor: detal</div>}</span>
                <span className="meta">{p.marcaAplica ?? '—'} · Stock {st}{ap ? ` · ${ap} apartadas · disponible ${st - ap}` : ''}</span>
              </button>
            );
          })}
        </div>
      )}
      {lineas.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Código</th><th className="desc">Producto</th><th className="num">Stock</th><th className="num">Apartado otros</th><th className="num">Disponible</th><th className="num">Cantidad</th><th className="num">Precio $</th><th className="num">Total</th><th></th></tr></thead>
            <tbody>
              {lineas.map((l) => {
                const p = porId.get(l.producto.id) ?? l.producto;
                const st = stock.get(p.id) ?? 0; const ap = apart.get(p.id) ?? 0;
                const n = parseEntero(l.cantidad); const pr = parseNum(l.precio);
                const falta = n !== null && n > st - ap;
                return (
                  <tr key={p.id}>
                    <td className="mono">{p.codigo}</td>
                    <td className="desc">{p.descripcion}{pr !== null && p.costo > 0 && pr < p.costo && <div className="small" style={{ color: 'var(--warn)' }}>Precio por debajo del costo ({usd(p.costo)})</div>}</td>
                    <td className="num">{st}</td><td className="num">{ap || ''}</td>
                    <td className={`num ${falta ? 'stock-neg' : ''}`}>{st - ap}</td>
                    <td className="num"><input className={`input cell qty${n === null || n <= 0 ? ' invalid' : ''}`} aria-label={`Cantidad ${p.codigo}`} inputMode="numeric" value={l.cantidad} onChange={(e) => cambiar(p.id, { cantidad: e.target.value })} /></td>
                    <td className="num"><input className={`input cell${pr === null || pr <= 0 ? ' invalid' : ''}`} aria-label={`Precio ${p.codigo}`} inputMode="decimal" value={l.precio} onChange={(e) => cambiar(p.id, { precio: e.target.value })} /></td>
                    <td className="num">{n && pr ? usd(round2(n * pr)) : '—'}</td>
                    <td><button className="btn ghost small" onClick={() => setLineas((ls) => ls.filter((x) => x.producto.id !== p.id))}>Quitar</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {lineas.length === 0 && <div className="muted">Busca y agrega los productos del pedido. El precio sale del precio mayor del producto y se puede cambiar.</div>}
      {lineas.some((l) => (parseEntero(l.cantidad) ?? 0) > (stock.get(l.producto.id) ?? 0) - (apart.get(l.producto.id) ?? 0)) && (
        <div className="alert warn">Hay productos sin piezas disponibles suficientes. Se puede apartar igual (queda pendiente hasta que llegue la mercancía); si lo despachas ahora, el stock queda en negativo.</div>
      )}
      {error && lineas.length > 0 && <div className="alert bad">{error}</div>}
      <div className="total-box"><span className="label">Total</span><span className="amount">{usd(total)}</span></div>
      <div className="row">
        {pedido && <button className="btn ghost" onClick={() => onListo('pendientes')}>Volver sin guardar</button>}
        <span className="spacer" />
        <button className="btn" disabled={!listo} onClick={async () => {
          const r = await accion(() => guardarPedido(db, ctx, datos(), pedido?.id), pedido ? 'Pedido actualizado' : 'Pedido apartado');
          if (r) onListo('pendientes');
        }}>{pedido ? 'Guardar cambios' : 'Apartar (pedido pendiente)'}</button>
        <button className="btn primary" disabled={!listo} onClick={() => setCobrando(true)}>Despachar y cobrar</button>
      </div>
      {cobrando && (
        <Cobro total={total} tasa={tasa ?? null} conCliente={false} titulo={`Cobrar venta al mayor · ${cliente}`} boton="Registrar venta al mayor"
          onClose={() => setCobrando(false)}
          onCobrar={async (cobro) => {
            const v = await venderMayor(db, ctx, datos(), cobro, pedido?.id);
            setCobrando(false); setTicket(v);
          }} />
      )}
      {ticket && (
        <Modal titulo={`Venta al mayor ${ticket.numero}`} onClose={() => onListo('ventas')}>
          <div className="alert good">Venta al mayor registrada: salió del inventario.{ticket.pagos.filter((p) => p.tipo === 'vuelto').map((p) => <span key={p.id}> Vuelto: <strong>{enMoneda(-p.montoMoneda, p.moneda)}</strong> en {medio(p.medio).nombre.toLowerCase()}.</span>)}</div>
          <Ticket venta={ticket} negocio={negocio} />
          <div className="row"><span className="spacer" />
            {import.meta.env.MODE !== 'demo' && <button className="btn" onClick={() => window.print()}>Imprimir</button>}
            <button className="btn primary" autoFocus onClick={() => onListo('ventas')}>Listo</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Pendientes({ pedidos, onAbrir }: { pedidos: PedidoMayor[]; onAbrir: (p: PedidoMayor) => void }) {
  const { ctx } = useApp();
  const stock = useStock(ctx.sedeId);
  const accion = useAccion();
  const [cancelar, setCancelar] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  // Se reparte el stock por orden de llegada: el pedido más viejo se cubre primero.
  const cubre = useMemo(() => {
    const queda = new Map(stock);
    const out = new Map<string, number>(); // pedidoId → piezas que faltan
    for (const p of pedidos) {
      let faltan = 0;
      for (const i of p.items) {
        const hay = Math.max(0, queda.get(i.productoId) ?? 0);
        faltan += Math.max(0, i.cantidad - hay);
        queda.set(i.productoId, hay - i.cantidad);
      }
      out.set(p.id, faltan);
    }
    return out;
  }, [pedidos, stock]);
  if (pedidos.length === 0) return <div className="panel"><div className="muted">No hay pedidos pendientes.</div></div>;
  return (
    <div className="panel">
      <div className="muted small">El stock se reparte por orden de llegada: el pedido más viejo se cubre primero. “Listo” = ya hay piezas para despacharlo completo.</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Pedido</th><th>Fecha</th><th>Cliente</th><th className="desc">Productos</th><th className="num">Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {pedidos.map((p) => {
              const faltan = cubre.get(p.id) ?? 0;
              return (
                <tr key={p.id}>
                  <td className="mono">{p.numero}</td><td className="small">{fechaHora(p.creadoEn)}</td>
                  <td>{p.clienteNombre}{p.nota && <div className="muted small">{p.nota}</div>}</td>
                  <td className="desc small">{p.items.map((i) => `${i.cantidad} × ${i.descripcion}`).join(' · ')}</td>
                  <td className="num">{usd(p.total)}</td>
                  <td>{faltan === 0 ? <span className="badge good">Listo</span> : <span className="badge warn">Faltan {faltan} pzs</span>}</td>
                  <td>
                    {cancelar === p.id ? (
                      <form className="row" style={{ flexWrap: 'nowrap', gap: 4 }} onSubmit={async (e) => {
                        e.preventDefault();
                        const r = await accion(() => cancelarPedido(db, ctx, p.id, motivo), 'Pedido cancelado: las piezas vuelven a la tienda');
                        if (r) { setCancelar(null); setMotivo(''); }
                      }}>
                        <input className="input" aria-label="Motivo de cancelación" placeholder="Motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
                        <button className="btn danger" disabled={!motivo.trim()}>Cancelar pedido</button>
                        <button type="button" className="btn ghost" onClick={() => setCancelar(null)}>No</button>
                      </form>
                    ) : (
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                        <button className="btn primary small" onClick={() => onAbrir(p)}>Abrir</button>
                        <button className="btn ghost small" onClick={() => { setCancelar(p.id); setMotivo(''); }}>Cancelar</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VentasMayor() {
  const { ctx, negocio } = useApp();
  const [desde, setDesde] = useState(diaLocal().slice(0, 8) + '01');
  const [abierta, setAbierta] = useState<Venta | null>(null);
  const ventas = useLiveQuery(() => db.ventas.where('dia').aboveOrEqual(desde).filter((v) => v.sedeId === ctx.sedeId && v.canal === 'mayor').reverse().sortBy('creadaEn'), [desde, ctx.sedeId]) ?? [];
  const cancelados = useLiveQuery(() => db.pedidos.where('estado').equals('cancelado').filter((p) => p.sedeId === ctx.sedeId && p.creadoEn.slice(0, 10) >= desde).toArray(), [desde, ctx.sedeId]) ?? [];
  const ok = ventas.filter((v) => v.estado === 'completada');
  const total = round2(ok.reduce((a, v) => a + v.total, 0));
  const utilidad = round2(total - ok.reduce((a, v) => a + v.costoTotal, 0));
  return (
    <div className="panel">
      <div className="row center">
        <Campo label="Desde"><input id="mayor-desde" type="date" className="input" value={desde} onChange={(e) => e.target.value && setDesde(e.target.value)} /></Campo>
        <span className="spacer" />
        <strong>{ok.length} ventas · {usd(total)} · utilidad {usd(utilidad)}</strong>
      </div>
      {ventas.length === 0 ? <div className="muted">No hay ventas al mayor desde esa fecha.</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Número</th><th>Cliente</th><th>Vendió</th><th className="num">Piezas</th><th className="num">Total</th><th>Pago</th><th>Estado</th></tr></thead>
          <tbody>{ventas.map((v) => (
            <tr key={v.id} className="click" onClick={() => setAbierta(v)}>
              <td className="small">{fechaHora(v.creadaEn)}</td><td className="mono">{v.numero}</td><td>{v.clienteNombre}</td><td className="small">{v.usuarioNombre}</td>
              <td className="num">{v.items.reduce((a, i) => a + i.cantidad, 0)}</td><td className="num">{usd(v.total)}</td>
              <td className="small">{[...new Set(v.pagos.map(normalizarPago).filter((p) => p.tipo === 'pago').map((p) => medio(p.medio).corto))].join(' + ')}</td>
              <td>{v.estado === 'anulada' ? <span className="badge bad">Anulada</span> : <span className="badge good">OK</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {cancelados.length > 0 && (
        <>
          <h3>Pedidos cancelados</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Pedido</th><th>Cliente</th><th className="num">Total</th><th>Motivo</th></tr></thead>
            <tbody>{cancelados.map((p) => <tr key={p.id}><td className="mono">{p.numero}</td><td>{p.clienteNombre}</td><td className="num">{usd(p.total)}</td><td>{p.motivoCancelacion}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
      {abierta && <DetalleVenta venta={abierta} onClose={() => setAbierta(null)} negocio={negocio} />}
    </div>
  );
}
