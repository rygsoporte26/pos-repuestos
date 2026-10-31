import type { Negocio, Venta } from '../../db/types';
import { fechaHora, num2 } from '../../domain/util';
import { medio, normalizarPago } from '../../domain/pagos';

/** Ticket de venta (no fiscal). Se ve en pantalla; luego se podrá imprimir en térmica. */
export function Ticket({ venta, negocio }: { venta: Venta; negocio: Negocio }) {
  const pagos = venta.pagos.map(normalizarPago);
  return (
    <div className="ticket" aria-label={`Ticket ${venta.numero}`}>
      <div className="c big">{negocio.nombre}</div>
      {negocio.direccion && <div className="c">{negocio.direccion}</div>}
      {negocio.telefono && <div className="c">Tel. {negocio.telefono}</div>}
      <hr />
      {venta.canal === 'mayor' && <div className="c big">VENTA AL MAYOR</div>}
      <div className="l"><span>{venta.canal === 'mayor' ? 'Número' : 'Ticket'}</span><span>{venta.numero}</span></div>
      <div className="l"><span>Fecha</span><span>{fechaHora(venta.creadaEn)}</span></div>
      <div className="l"><span>Atendió</span><span>{venta.usuarioNombre}</span></div>
      {venta.clienteNombre && <div className="l"><span>Cliente</span><span>{venta.clienteNombre}</span></div>}
      {venta.clienteTelefono && <div className="l"><span>Teléfono</span><span>{venta.clienteTelefono}</span></div>}
      <hr />
      {venta.items.map((i) => (
        <div key={i.id} style={{ marginBottom: 4 }}>
          <div>{i.descripcion}</div>
          <div className="l">
            <span>{i.cantidad} x {num2(i.precioUnitario)}{i.tipoPrecio === 'mayor' ? ' (MAYOR)' : ''}</span>
            <span>{num2(i.total)}</span>
          </div>
        </div>
      ))}
      <hr />
      <div className="l big"><span>TOTAL USD</span><span>{num2(venta.total)}</span></div>
      {venta.totalBs !== null && venta.totalBs !== undefined && <div className="l"><span>TOTAL Bs</span><span>{num2(venta.totalBs)}</span></div>}
      {venta.tasa ? <div className="l"><span>Tasa BCV</span><span>{num2(venta.tasa)}</span></div> : null}
      <hr />
      {pagos.map((p) => (
        <div key={p.id}>
          <div className="l">
            <span>{p.tipo === 'vuelto' ? 'Vuelto' : 'Pago'} {medio(p.medio).corto}</span>
            <span>{p.moneda === 'VES' ? 'Bs ' : '$ '}{num2(Math.abs(p.montoMoneda))}</span>
          </div>
          {p.referencia && <div style={{ fontSize: 11 }}>Ref. {p.referencia}</div>}
          {p.recibido !== undefined && p.cambio ? <div className="l"><span>Cambio</span><span>{num2(p.cambio)}</span></div> : null}
        </div>
      ))}
      {venta.estado === 'anulada' && (
        <>
          <hr />
          <div className="c big">*** ANULADA ***</div>
          <div className="c">{venta.motivoAnulacion}</div>
        </>
      )}
      <hr />
      <div className="c">{negocio.mensajeTicket}</div>
      <div className="c" style={{ fontSize: 11 }}>Documento no fiscal</div>
    </div>
  );
}
