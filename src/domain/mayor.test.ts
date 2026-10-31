import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PosDB } from '../db/db';
import type { Producto, Usuario } from '../db/types';
import { textoBusqueda } from './buscar';
import { apartados, cancelarPedido, guardarPedido, prefijoMayor, venderMayor } from './mayor';
import { registrarEntrada, registrarConteo, stockDe } from './inventario';
import { abrirCaja, resumenCaja, sesionAbierta } from './caja';
import { anularVenta, registrarVenta } from './ventas';
import type { Contexto } from './contexto';

const prod = (over: Partial<Producto> = {}): Producto => {
  const p: Producto = {
    id: 'p1', codigo: 'RYG0001', descripcion: 'PASTILLA FRENO', familia: 'FRENOS', marcaAplica: 'BERA', presentacion: null,
    unidadesBulto: null, unidadCompra: 'PIEZA', costo: 2, precioDetal: 5, precioMayor: 4, cantMinMayor: 10, stockMinimo: 0,
    activo: true, actualizadoEn: '', busqueda: '', ...over,
  };
  p.busqueda = textoBusqueda(p);
  return p;
};
const usuario = (rol: Usuario['rol']): Usuario => ({ id: rol, nombre: rol, rol, sedeId: rol === 'supervisor' ? null : 'S', activo: true });
const ctx = (rol: Usuario['rol'] = 'admin'): Contexto => ({ usuario: usuario(rol), sedeId: 'S', sedeCodigo: 'S1', dispositivoId: 'D1', dispositivoCodigo: 'C1' });
const efectivo = (n: number) => ({ pagos: [{ medio: 'efectivo_usd' as const, montoMoneda: n }], vuelto: { medio: 'efectivo_usd' as const }, tasa: null });

describe('ventas al mayor', () => {
  let d: PosDB;
  const p1 = prod();
  const p2 = prod({ id: 'p2', codigo: 'RYG0002', descripcion: 'GUAYA CLUTCH', precioDetal: 3, precioMayor: null, cantMinMayor: null, costo: 1 });
  beforeEach(async () => {
    d = new PosDB(`m-${Math.random()}`);
    await d.productos.bulkAdd([p1, p2]);
  });

  it('solo administrador y supervisor; el vendedor no', async () => {
    const datos = { clienteNombre: 'Taller Pepe', lineas: [{ producto: p1, cantidad: 10 }] };
    await expect(guardarPedido(d, ctx('vendedor'), datos)).rejects.toThrow('permiso');
    await expect(venderMayor(d, ctx('vendedor'), datos, efectivo(40))).rejects.toThrow('permiso');
    await expect(guardarPedido(d, ctx('admin'), { ...datos, clienteNombre: ' ' })).rejects.toThrow('cliente');
    expect(prefijoMayor(ctx('admin'))).toBe('S1-MC1-');
    expect(prefijoMayor(ctx('supervisor'))).toBe('S1-MSV-');
  });

  it('pedido aparta piezas, la entrada las cubre, se despacha cobrado y sale del inventario', async () => {
    // El cliente pide 60 pastillas y 20 guayas antes de que llegue la mercancía.
    const ped = await guardarPedido(d, ctx('supervisor'), {
      clienteNombre: 'Repuestos El Llano', clienteTelefono: '0414', nota: 'entrega viernes',
      lineas: [{ producto: p1, cantidad: 60 }, { producto: p2, cantidad: 20, precio: 2.5 }],
    });
    expect(ped).toMatchObject({ numero: 'S1-MSV-000001', estado: 'pendiente', total: 290 }); // 60×4 + 20×2,5
    expect((await apartados(d, 'S')).get('p1')).toBe(60);
    // Llega el pedido del proveedor: 100 pastillas y 20 guayas.
    await registrarEntrada(d, ctx('admin'), 'p1', 100);
    await registrarEntrada(d, ctx('admin'), 'p2', 20);
    // Despacho: cobra completo y descuenta.
    const v = await venderMayor(d, ctx('supervisor'), {
      clienteNombre: ped.clienteNombre, clienteTelefono: ped.clienteTelefono,
      lineas: [{ producto: p1, cantidad: 60, precio: 4 }, { producto: p2, cantidad: 20, precio: 2.5 }],
    }, efectivo(290), ped.id);
    expect(v).toMatchObject({ canal: 'mayor', numero: 'S1-MSV-000001', total: 290, sesionCajaId: '', dispositivoId: '', pedidoId: ped.id, clienteNombre: 'Repuestos El Llano' });
    expect(v.items.every((i) => i.tipoPrecio === 'mayor')).toBe(true);
    expect(v.costoTotal).toBe(140); // 60×2 + 20×1
    expect(await stockDe(d, 'S', 'p1')).toBe(40); // el resto queda para la tienda
    expect(await stockDe(d, 'S', 'p2')).toBe(0);
    expect((await apartados(d, 'S')).size).toBe(0);
    expect((await d.pedidos.get(ped.id))).toMatchObject({ estado: 'despachado', ventaId: v.id });
    // No se despacha dos veces.
    await expect(venderMayor(d, ctx('admin'), { clienteNombre: 'X', lineas: [{ producto: p1, cantidad: 1 }] }, efectivo(4), ped.id)).rejects.toThrow('despachado');
    // Se sube primero la venta y luego el pedido.
    const cola = (await d.outbox.orderBy('seq').toArray()).map((x) => x.tipo);
    expect(cola.lastIndexOf('venta')).toBeLessThan(cola.lastIndexOf('pedido'));
  });

  it('venta al mayor directa no toca la caja de la tienda; cancelar libera lo apartado; anular devuelve stock', async () => {
    await registrarConteo(d, ctx('admin'), 'p1', 50);
    await abrirCaja(d, ctx('admin'), 10);
    await registrarVenta(d, ctx('admin'), [{ producto: p1, cantidad: 2 }], efectivo(10));
    const v = await venderMayor(d, ctx('admin'), { clienteNombre: 'Moto Taller', lineas: [{ producto: p1, cantidad: 10 }] }, efectivo(40));
    expect(v.numero).toBe('S1-MC1-000001');
    expect(v.total).toBe(40);
    const caja = await resumenCaja(d, (await sesionAbierta(d, 'D1'))!);
    expect(caja).toMatchObject({ ventas: 1, totalUsd: 10, esperado: 20 }); // solo la venta de tienda
    expect(await stockDe(d, 'S', 'p1')).toBe(38);

    const ped = await guardarPedido(d, ctx('admin'), { clienteNombre: 'Otro', lineas: [{ producto: p1, cantidad: 30 }] });
    expect(ped.numero).toBe('S1-MC1-000002');
    expect((await apartados(d, 'S')).get('p1')).toBe(30);
    // Modificar el pedido mantiene su número.
    const mod = await guardarPedido(d, ctx('admin'), { clienteNombre: 'Otro', lineas: [{ producto: p1, cantidad: 25 }] }, ped.id);
    expect(mod.numero).toBe('S1-MC1-000002');
    expect((await apartados(d, 'S')).get('p1')).toBe(25);
    await expect(cancelarPedido(d, ctx('admin'), ped.id, ' ')).rejects.toThrow('motivo');
    await cancelarPedido(d, ctx('admin'), ped.id, 'cliente desistió');
    expect((await apartados(d, 'S')).get('p1')).toBeUndefined();
    await expect(guardarPedido(d, ctx('admin'), { clienteNombre: 'Otro', lineas: [{ producto: p1, cantidad: 1 }] }, ped.id)).rejects.toThrow('pendiente');

    await anularVenta(d, ctx('admin'), v.id, 'devolución');
    expect(await stockDe(d, 'S', 'p1')).toBe(48);
  });

  it('valida precios, cantidades y productos repetidos', async () => {
    await expect(venderMayor(d, ctx('admin'), { clienteNombre: 'A', lineas: [{ producto: p1, cantidad: 0 }] }, efectivo(1))).rejects.toThrow('enteros');
    await expect(guardarPedido(d, ctx('admin'), { clienteNombre: 'A', lineas: [{ producto: p1, cantidad: 2, precio: 0 }] })).rejects.toThrow('precio');
    await expect(guardarPedido(d, ctx('admin'), { clienteNombre: 'A', lineas: [{ producto: p1, cantidad: 2 }, { producto: p1, cantidad: 1 }] })).rejects.toThrow('repetido');
    await expect(venderMayor(d, ctx('admin'), { clienteNombre: 'A', lineas: [{ producto: p1, cantidad: 10 }] }, efectivo(39))).rejects.toThrow();
    // Sin precio mayor usa el detal como sugerido.
    const p = await guardarPedido(d, ctx('admin'), { clienteNombre: 'A', lineas: [{ producto: p2, cantidad: 4 }] });
    expect(p.items[0].precio).toBe(3);
  });
});
