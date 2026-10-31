import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Venta } from '../../db/types';
import { anularVenta } from '../../domain/ventas';
import { puede } from '../../domain/contexto';
import { diaLocal, hora, round2, usd } from '../../domain/util';
import { Campo, Modal, useAccion, useApp } from '../components/ui';
import { Ticket } from '../components/Ticket';
import { medio, normalizarPago } from '../../domain/pagos';

export function Ventas() {
  const { ctx, negocio } = useApp();
  const [dia, setDia] = useState(diaLocal());
  const [abierta, setAbierta] = useState<Venta | null>(null);
  const ventas = useLiveQuery(() => db.ventas.where('dia').equals(dia).filter((v) => v.sedeId === ctx.sedeId).reverse().sortBy('creadaEn'), [dia, ctx.sedeId]) ?? [];
  const completadas = ventas.filter((v) => v.estado === 'completada');
  const total = round2(completadas.reduce((a, v) => a + v.total, 0));

  return (
    <>
      <div className="row">
        <h1>Ventas</h1>
        <span className="spacer" />
        <Campo label="Día"><input id="dia-ventas" type="date" className="input" value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} /></Campo>
      </div>
      <div className="panel">
        <div className="row center">
          <strong>{completadas.length} ventas · {usd(total)}</strong>
          {ventas.length !== completadas.length && <span className="badge bad">{ventas.length - completadas.length} anuladas</span>}
        </div>
        {ventas.length === 0 ? <div className="muted">No hay ventas este día.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Hora</th><th>Ticket</th><th>Atendió</th><th>Cliente</th><th className="num">Productos</th><th className="num">Total</th><th>Pago</th><th>Estado</th></tr></thead>
              <tbody>
                {ventas.map((v) => (
                  <tr key={v.id} className="click" onClick={() => setAbierta(v)}>
                    <td>{hora(v.creadaEn)}</td><td className="mono">{v.numero}</td><td>{v.usuarioNombre}</td><td>{v.clienteNombre ?? ''}</td>
                    <td className="num">{v.items.reduce((a, i) => a + i.cantidad, 0)}</td><td className="num">{usd(v.total)}</td>
                    <td className="small">{[...new Set(v.pagos.map(normalizarPago).filter((p) => p.tipo === 'pago').map((p) => medio(p.medio).corto))].join(' + ')}</td>
                    <td>{v.estado === 'anulada' ? <span className="badge bad">Anulada</span> : <span className="badge good">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {abierta && <DetalleVenta venta={abierta} puedeAnular={puede(ctx.usuario.rol, 'anular')} onClose={() => setAbierta(null)} negocio={negocio} />}
    </>
  );
}

function DetalleVenta({ venta, puedeAnular, onClose, negocio }: { venta: Venta; puedeAnular: boolean; onClose: () => void; negocio: ReturnType<typeof useApp>['negocio'] }) {
  const { ctx } = useApp();
  const accion = useAccion();
  const [motivo, setMotivo] = useState('');
  const [v, setV] = useState(venta);
  return (
    <Modal titulo={`Ticket ${v.numero}`} onClose={onClose}>
      <Ticket venta={v} negocio={negocio} />
      {import.meta.env.MODE !== 'demo' && <div><button className="btn" onClick={() => window.print()}>Imprimir</button></div>}
      {v.estado === 'completada' && puedeAnular && (
        <form className="panel" onSubmit={async (e) => {
          e.preventDefault();
          const r = await accion(() => anularVenta(db, ctx, v.id, motivo), 'Venta anulada; el stock volvió al inventario');
          if (r) setV(r);
        }}>
          <h3>Anular venta</h3>
          <Campo label="Motivo (obligatorio)">
            <input id="motivo-anulacion" className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. el cliente devolvió el producto" />
          </Campo>
          <div><button className="btn danger" type="submit" disabled={!motivo.trim()}>Anular esta venta</button></div>
        </form>
      )}
      {v.estado === 'completada' && !puedeAnular && <div className="muted small">Para anular esta venta, pídeselo al administrador.</div>}
    </Modal>
  );
}
