import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PosDB } from '../db/db';
import type { Producto, Usuario } from '../db/types';
import { precioAplicable, revisarPrecios } from './precios';
import { buscarProductos, textoBusqueda } from './buscar';
import { anularVenta, calcularCarrito, registrarVenta } from './ventas';
import { abrirCaja, cerrarCaja, resumenCaja, sesionAbierta } from './caja';
import { registrarConteo, registrarEntrada, recalcularStock, stockDe } from './inventario';
import { guardarProducto } from './productos';
import type { Contexto } from './contexto';
import { parseNum, round2 } from './util';

const prod = (over: Partial<Producto> = {}): Producto => {
  const p: Producto = {
    id: over.id ?? 'p1', codigo: '1462', descripcion: 'BUJIA C7HSA', familia: 'BUJIAS', marcaAplica: 'JAGUAR 200',
    presentacion: '1X100', unidadesBulto: 100, unidadCompra: 'BULTO', costo: 0.8, precioDetal: 2, precioMayor: 1.5,
    cantMinMayor: 10, stockMinimo: 0, activo: true, actualizadoEn: '', busqueda: '', ...over,
  };
  p.busqueda = textoBusqueda(p);
  return p;
};

const usuario = (rol: Usuario['rol']): Usuario => ({ id: rol, nombre: rol, rol, sedeId: 'S', activo: true });
// Pago en efectivo $; si sobra, vuelto en efectivo $.
const efectivo = (n: number) => ({ pagos: [{ medio: 'efectivo_usd' as const, montoMoneda: n }], vuelto: { medio: 'efectivo_usd' as const }, tasa: null });
const ctx = (rol: Usuario['rol'] = 'admin'): Contexto => ({ usuario: usuario(rol), sedeId: 'S', sedeCodigo: 'S1', dispositivoId: 'D1', dispositivoCodigo: 'C1' });

describe('precios', () => {
  it('aplica detal bajo la cantidad mínima y mayor desde ella', () => {
    const p = prod();
    expect(precioAplicable(p, 9)).toEqual({ tipo: 'detal', precio: 2 });
    expect(precioAplicable(p, 10)).toEqual({ tipo: 'mayor', precio: 1.5 });
  });
  it('sin precio mayor siempre es detal; sin detal no se vende', () => {
    expect(precioAplicable(prod({ precioMayor: null, cantMinMayor: null }), 500)?.tipo).toBe('detal');
    expect(precioAplicable(prod({ precioDetal: null }), 1)).toBeNull();
  });
  it('detecta combinaciones inválidas', () => {
    expect(revisarPrecios(prod({ cantMinMayor: null })).some((x) => x.bloquea)).toBe(true);
    expect(revisarPrecios(prod({ precioMayor: 3 })).map((x) => x.mensaje)).toContain('El mayor debería ser menor que el detal');
    expect(revisarPrecios(prod({ precioDetal: 0.5 })).map((x) => x.mensaje)).toContain('Detal por debajo del costo');
  });
  it('calcula totales sin errores de redondeo', () => {
    const { total } = calcularCarrito([{ producto: prod({ precioDetal: 0.1, precioMayor: null, cantMinMayor: null }), cantidad: 3 }]);
    expect(total).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(parseNum('1.234,56')).toBe(1234.56);
    expect(parseNum('2,5')).toBe(2.5);
    expect(parseNum('')).toBeNull();
  });
});

describe('búsqueda', () => {
  const lista = [prod(), prod({ id: 'p2', codigo: '14620', descripcion: 'PASTILLA DE FRENO', familia: 'FRENOS', marcaAplica: 'HORSE' }), prod({ id: 'p3', codigo: '200', descripcion: 'BUJÍA LARGA', marcaAplica: 'BERA' })];
  it('código exacto primero y luego prefijos', () => {
    expect(buscarProductos(lista, '1462').map((p) => p.id)).toEqual(['p1', 'p2']);
  });
  it('busca por moto y sin tildes, todas las palabras', () => {
    expect(buscarProductos(lista, 'pastilla horse').map((p) => p.id)).toEqual(['p2']);
    expect(buscarProductos(lista, 'bujia').map((p) => p.id).sort()).toEqual(['p1', 'p3']);
  });
});

describe('flujo de venta, caja e inventario', () => {
  let d: PosDB;
  beforeEach(async () => {
    d = new PosDB(`t-${Math.random()}`);
    await d.productos.add(prod());
  });

  it('no deja vender sin caja abierta', async () => {
    await expect(registrarVenta(d, ctx(), [{ producto: prod(), cantidad: 1 }], efectivo(5))).rejects.toThrow('Abre la caja');
  });

  it('vende, descuenta stock, numera, cierra caja con arqueo y anula', async () => {
    await registrarConteo(d, ctx(), 'p1', 50);
    expect(await stockDe(d, 'S', 'p1')).toBe(50);
    await abrirCaja(d, ctx('vendedor'), 20);
    // En la tienda siempre es precio detal, aunque lleve más de la cantidad mínima mayor.
    const v1 = await registrarVenta(d, ctx('vendedor'), [{ producto: prod(), cantidad: 12 }], { ...efectivo(30), clienteNombre: 'Taller Pepe' });
    expect(v1.total).toBe(24); // 12 x 2 detal
    expect(v1.items[0].tipoPrecio).toBe('detal');
    expect(v1.canal).toBe('tienda');
    expect(v1.pagos.find((p) => p.tipo === 'vuelto')?.montoMoneda).toBe(-6);
    expect(v1.numero).toBe('S1-C1-000001');
    const v2 = await registrarVenta(d, ctx('vendedor'), [{ producto: prod(), cantidad: 3 }], efectivo(6));
    expect(v2.numero).toBe('S1-C1-000002');
    expect(await stockDe(d, 'S', 'p1')).toBe(35);

    await expect(anularVenta(d, ctx('vendedor'), v2.id, 'error')).rejects.toThrow('permiso');
    await expect(anularVenta(d, ctx('admin'), v2.id, '  ')).rejects.toThrow('motivo');
    await anularVenta(d, ctx('admin'), v2.id, 'cliente devolvió');
    expect(await stockDe(d, 'S', 'p1')).toBe(38);

    const s = (await sesionAbierta(d, 'D1'))!;
    const r = await resumenCaja(d, s);
    expect(r).toMatchObject({ ventas: 1, totalUsd: 24, anuladas: 1, esperado: 44, esperadoBs: 0 });
    const cerrada = await cerrarCaja(d, ctx('vendedor'), 43, 0);
    expect(cerrada.diferencia).toBe(-1);
    expect(await sesionAbierta(d, 'D1')).toBeUndefined();

    // la caché de stock coincide con la suma de movimientos
    await recalcularStock(d);
    expect(await stockDe(d, 'S', 'p1')).toBe(38);
    // venta, sesión x2, anulación, conteo → todo en la cola de la nube
    expect((await d.outbox.toArray()).map((o) => o.tipo).sort()).toEqual(['anulacion', 'movimiento', 'sesion_caja', 'sesion_caja', 'venta', 'venta']);
  });

  it('rechaza efectivo insuficiente y productos sin precio', async () => {
    await abrirCaja(d, ctx(), 0);
    await expect(registrarVenta(d, ctx(), [{ producto: prod(), cantidad: 2 }], efectivo(3))).rejects.toThrow('Falta cobrar');
    await expect(registrarVenta(d, ctx(), [{ producto: prod({ precioDetal: null, precioMayor: null, cantMinMayor: null }), cantidad: 1 }], efectivo(9))).rejects.toThrow('no tiene precio');
    expect(await d.ventas.count()).toBe(0);
  });

  it('conteo: inicial la primera vez, ajuste por diferencia después; entrada suma', async () => {
    expect(await registrarConteo(d, ctx(), 'p1', 10)).toBe(10);
    expect(await registrarConteo(d, ctx(), 'p1', 10)).toBe(0);
    expect(await registrarConteo(d, ctx(), 'p1', 7)).toBe(-3);
    await registrarEntrada(d, ctx(), 'p1', 100, { costo: 0.9, actualizarCosto: true });
    expect(await stockDe(d, 'S', 'p1')).toBe(107);
    expect((await d.productos.get('p1'))!.costo).toBe(0.9);
    const tipos = (await d.movimientos.toArray()).map((m) => m.tipo);
    expect(tipos.sort()).toEqual(['ajuste', 'compra', 'inicial']);
    await expect(registrarConteo(d, ctx('vendedor'), 'p1', 1)).rejects.toThrow('permiso');
  });

  it('guarda precios validando y bloquea mayor sin cantidad mínima', async () => {
    await expect(guardarProducto(d, ctx(), 'p1', { precioMayor: 1, cantMinMayor: null })).rejects.toThrow('van juntos');
    const avisos = await guardarProducto(d, ctx(), 'p1', { precioDetal: 2.5, precioMayor: 2.6, cantMinMayor: 6 });
    expect(avisos).toContain('El mayor debería ser menor que el detal');
    expect((await d.productos.get('p1'))!.precioDetal).toBe(2.5);
    await expect(guardarProducto(d, ctx('vendedor'), 'p1', { precioDetal: 1 })).rejects.toThrow('permiso');
  });
});
