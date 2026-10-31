import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { bs, diaLocal, fechaHora, round2, usd } from '../../domain/util';
import { Campo, useApp } from '../components/ui';
import { useProductos, useStock } from '../hooks';
import { TablaMedios } from './Caja';
import { totalesPorMedio } from '../../domain/pagos';

const dias = (hasta: string, n: number) => {
  const out: string[] = [];
  const [y, m, d] = hasta.split('-').map(Number);
  for (let i = n - 1; i >= 0; i--) out.push(diaLocal(new Date(y, m - 1, d - i)));
  return out;
};
const corto = (dia: string) => {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-VE', { weekday: 'short', day: '2-digit' });
};

export function Panel() {
  const { ctx, irA } = useApp();
  const [dia, setDia] = useState(diaLocal());
  const semana = useMemo(() => dias(dia, 7), [dia]);
  const ventas = useLiveQuery(() => db.ventas.where('dia').between(semana[0], semana[6], true, true).filter((v) => v.sedeId === ctx.sedeId).toArray(), [semana.join(), ctx.sedeId]) ?? [];
  const sesiones = useLiveQuery(() => db.sesiones.orderBy('abiertaEn').reverse().filter((s) => s.sedeId === ctx.sedeId).limit(10).toArray(), [ctx.sedeId]) ?? [];
  const pendientes = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  const pedidos = useLiveQuery(() => db.pedidos.where('estado').equals('pendiente').filter((p) => p.sedeId === ctx.sedeId).toArray(), [ctx.sedeId]) ?? [];
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);

  const hoy = ventas.filter((v) => v.dia === dia);
  const ok = hoy.filter((v) => v.estado === 'completada');
  const anuladas = hoy.filter((v) => v.estado === 'anulada');
  const total = round2(ok.reduce((a, v) => a + v.total, 0));
  const costo = round2(ok.reduce((a, v) => a + v.costoTotal, 0));
  const utilidad = round2(total - costo);
  const deCanal = (c: 'tienda' | 'mayor') => ok.filter((v) => (v.canal ?? 'tienda') === c);
  const tienda = round2(deCanal('tienda').reduce((a, v) => a + v.total, 0));
  const mayor = round2(deCanal('mayor').reduce((a, v) => a + v.total, 0));
  const porDia = semana.map((d) => ({ d, t: round2(ventas.filter((v) => v.dia === d && v.estado === 'completada').reduce((a, v) => a + v.total, 0)) }));
  const max = Math.max(1, ...porDia.map((x) => x.t));

  const top = useMemo(() => {
    const m = new Map<string, { codigo: string; desc: string; cant: number; total: number }>();
    for (const v of ventas) if (v.estado === 'completada') for (const i of v.items) {
      const t = m.get(i.productoId) ?? { codigo: i.codigo, desc: i.descripcion, cant: 0, total: 0 };
      t.cant += i.cantidad; t.total = round2(t.total + i.total);
      m.set(i.productoId, t);
    }
    return [...m.values()].sort((a, b) => b.total - a.total).slice(0, 10);
  }, [ventas]);

  const alertas = productos
    .filter((p) => p.activo)
    .map((p) => ({ p, st: stock.get(p.id) ?? 0 }))
    .filter(({ p, st }) => st < 0 || (p.stockMinimo > 0 && st <= p.stockMinimo))
    .sort((a, b) => a.st - b.st);
  const sinPrecio = productos.filter((p) => p.activo && p.precioDetal === null).length;

  return (
    <>
      <div className="row">
        <h1>Panel</h1>
        <span className="spacer" />
        <Campo label="Día"><input id="dia-panel" type="date" className="input" value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} /></Campo>
      </div>
      <div className="kpis">
        <div className="kpi"><span className="label">Vendido</span><span className="v">{usd(total)}</span><span className="s">{ok.length} {ok.length === 1 ? "venta" : "ventas"}</span></div>
        <div className="kpi"><span className="label">Tienda / Mayor</span><span className="v">{usd(tienda)}</span><span className="s">al mayor {usd(mayor)} ({deCanal('mayor').length})</span></div>
        <div className="kpi"><span className="label">Pedidos al mayor pendientes</span><span className="v">{pedidos.length}</span><span className="s">{usd(round2(pedidos.reduce((a, p) => a + p.total, 0)))} apartados</span></div>
        <div className="kpi"><span className="label">Utilidad bruta</span><span className="v">{usd(utilidad)}</span><span className="s">{total > 0 ? `${Math.round((utilidad / total) * 100)}% del vendido` : 'precio − costo'}</span></div>
        <div className="kpi"><span className="label">Ticket promedio</span><span className="v">{usd(ok.length ? round2(total / ok.length) : 0)}</span><span className="s">por venta</span></div>
        <div className="kpi"><span className="label">Anuladas</span><span className="v" style={{ color: anuladas.length ? 'var(--bad)' : undefined }}>{anuladas.length}</span><span className="s">{usd(round2(anuladas.reduce((a, v) => a + v.total, 0)))}</span></div>
      </div>
      {(sinPrecio > 0 || pendientes > 0) && (
        <div className="row">
          {sinPrecio > 0 && <div className="alert warn row center" style={{ flex: 1 }}><span>{sinPrecio} productos todavía sin precio: no se pueden vender.</span><span className="spacer" /><button className="btn" onClick={() => irA('productos')}>Cargar precios</button></div>}
          {pendientes > 0 && <div className="alert info" style={{ flex: 1 }}>{pendientes} cambios guardados en este equipo, listos para subir a la nube cuando se conecte Supabase.</div>}
        </div>
      )}
      <div className="grid-vender">
        <section className="panel">
          <h2>Ventas de los últimos 7 días</h2>
          <div className="bars">
            {porDia.map((x) => (
              <div className="bar-row" key={x.d}>
                <span className="small" style={{ fontWeight: x.d === dia ? 700 : 400 }}>{corto(x.d)}</span>
                <div className="bar-track"><div className="bar" style={{ width: `${(x.t / max) * 100}%`, opacity: x.d === dia ? 1 : 0.55 }} /></div>
                <span className="num small">{usd(x.t)}</span>
              </div>
            ))}
          </div>
          <h2>Más vendidos (7 días)</h2>
          {top.length === 0 ? <div className="muted">Sin ventas en estos días.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Código</th><th className="desc">Producto</th><th className="num">Piezas</th><th className="num">Vendido</th></tr></thead>
              <tbody>{top.map((t) => <tr key={t.codigo}><td className="mono">{t.codigo}</td><td className="desc">{t.desc}</td><td className="num">{t.cant}</td><td className="num">{usd(t.total)}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
        <section className="panel">
          <h2>Cobrado por método (día)</h2>
          <TablaMedios porMedio={totalesPorMedio(ok.flatMap((v) => v.pagos))} />
          <h2>Stock bajo o negativo</h2>
          {alertas.length === 0 ? <div className="muted">Sin alertas. Se activan cuando un producto tiene stock mínimo y baja de él, o queda en negativo.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Código</th><th className="desc">Producto</th><th className="num">Stock</th><th className="num">Mín.</th></tr></thead>
              <tbody>{alertas.slice(0, 30).map(({ p, st }) => <tr key={p.id}><td className="mono">{p.codigo}</td><td className="desc">{p.descripcion}</td><td className={`num ${st < 0 ? 'stock-neg' : 'stock-low'}`}>{st}</td><td className="num">{p.stockMinimo}</td></tr>)}</tbody>
            </table></div>
          )}
          <h2>Cajas recientes</h2>
          {sesiones.length === 0 ? <div className="muted">Todavía no se ha abierto ninguna caja.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Apertura</th><th>Usuario</th><th className="num">Diferencia</th></tr></thead>
              <tbody>{sesiones.map((s) => (
                <tr key={s.id}><td className="small">{fechaHora(s.abiertaEn)}</td><td className="small">{s.usuarioNombre}</td>
                  <td className="num">{s.cerradaEn === null ? <span className="badge accent">Abierta</span> : <span className={`badge ${s.diferencia === 0 && !s.diferenciaBs ? 'good' : (s.diferencia ?? 0) < 0 || (s.diferenciaBs ?? 0) < 0 ? 'bad' : 'warn'}`}>{usd(s.diferencia)}{s.diferenciaBs ? ` · ${bs(s.diferenciaBs)}` : ''}</span>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {anuladas.length > 0 && (
            <>
              <h2>Anulaciones del día</h2>
              <div className="table-wrap"><table>
                <thead><tr><th>Ticket</th><th>Anuló</th><th>Motivo</th><th className="num">Total</th></tr></thead>
                <tbody>{anuladas.map((v) => <tr key={v.id}><td className="mono">{v.numero}</td><td>{v.anuladaPor}</td><td>{v.motivoAnulacion}</td><td className="num">{usd(v.total)}</td></tr>)}</tbody>
              </table></div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
