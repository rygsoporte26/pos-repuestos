import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PosDB } from '../db/db';
import type { Producto, Usuario } from '../db/types';
import { armarPagos, estadoCobro, saldoEn, totalesPorMedio } from './pagos';
import { abrirCaja, cerrarCaja, resumenCaja, sesionAbierta } from './caja';
import { registrarVenta } from './ventas';
import { textoBusqueda } from './buscar';
import type { Contexto } from './contexto';

const TASA = 210.37; // Bs por USD (ejemplo)
const suma = (ps: { monto: number }[]) => Math.round(ps.reduce((a, p) => a + p.monto, 0) * 100) / 100;

describe('métodos de pago y tasa', () => {
  it('pago completo en Bs (pago móvil) a la tasa del día, con referencia', () => {
    const bs = saldoEn(15, 'pago_movil', TASA)!;
    expect(bs).toBe(3155.55);
    const ps = armarPagos(15, [{ medio: 'pago_movil', montoMoneda: bs, referencia: '0123' }], TASA);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ moneda: 'VES', montoMoneda: 3155.55, tasa: TASA, monto: 15, referencia: '0123' });
  });

  it('pago mixto: $10 efectivo + resto por punto de venta; la suma en USD es exacta', () => {
    const falta = estadoCobro(23.47, [{ medio: 'efectivo_usd', montoMoneda: 10 }], TASA).falta;
    expect(falta).toBe(13.47);
    const ps = armarPagos(23.47, [{ medio: 'efectivo_usd', montoMoneda: 10 }, { medio: 'punto_venta', montoMoneda: saldoEn(falta, 'punto_venta', TASA)!, referencia: '998877' }], TASA);
    expect(suma(ps)).toBe(23.47);
  });

  it('vuelto en Bs de un pago en dólares', () => {
    const ps = armarPagos(15, [{ medio: 'efectivo_usd', montoMoneda: 20 }], TASA, { medio: 'efectivo_bs' });
    const v = ps.find((p) => p.tipo === 'vuelto')!;
    expect(v).toMatchObject({ medio: 'efectivo_bs', moneda: 'VES', monto: -5, montoMoneda: -1051.85 });
    expect(suma(ps)).toBe(15);
  });

  it('reglas: referencia obligatoria, tasa obligatoria para Bs, falta dinero, vuelto por un medio permitido', () => {
    expect(() => armarPagos(10, [{ medio: 'binance', montoMoneda: 10 }], null)).toThrow('Falta la referencia de Binance');
    expect(() => armarPagos(10, [{ medio: 'efectivo_bs', montoMoneda: 2000 }], null)).toThrow('tasa BCV');
    expect(() => armarPagos(10, [{ medio: 'efectivo_usd', montoMoneda: 5 }], TASA)).toThrow('Falta cobrar $ 5.00');
    expect(() => armarPagos(10, [{ medio: 'efectivo_usd', montoMoneda: 20 }], TASA)).toThrow('elige cómo');
    expect(() => armarPagos(10, [{ medio: 'efectivo_usd', montoMoneda: 20 }], TASA, { medio: 'punto_venta' })).toThrow('No se da vuelto');
  });

  it('un Bs de más o de menos por redondeo no genera vuelto ni falta', () => {
    expect(estadoCobro(15, [{ medio: 'efectivo_bs', montoMoneda: 3155 }], TASA)).toMatchObject({ falta: 0, exceso: 0 });
    const ps = armarPagos(15, [{ medio: 'efectivo_bs', montoMoneda: 3155 }], TASA);
    expect(suma(ps)).toBe(15);
  });

  it('caja: arqueo separado en $ y Bs con vueltos y totales por método', async () => {
    const d = new PosDB(`pg-${Math.random()}`);
    const u: Usuario = { id: 'v', nombre: 'Vend', rol: 'vendedor', sedeId: 'S', activo: true };
    const ctx: Contexto = { usuario: u, sedeId: 'S', sedeCodigo: 'S1', dispositivoId: 'D', dispositivoCodigo: 'C1' };
    const p: Producto = { id: 'p', codigo: '1', descripcion: 'BUJIA', familia: null, marcaAplica: null, presentacion: null, unidadesBulto: null, unidadCompra: null, costo: 1, precioDetal: 5, precioMayor: null, cantMinMayor: null, stockMinimo: 0, activo: true, actualizadoEn: '', busqueda: '' };
    p.busqueda = textoBusqueda(p);
    await abrirCaja(d, ctx, 20, 1000);
    // Venta 1: $15 → paga $20, vuelto Bs
    await registrarVenta(d, ctx, [{ producto: p, cantidad: 3 }], { pagos: [{ medio: 'efectivo_usd', montoMoneda: 20 }], vuelto: { medio: 'efectivo_bs' }, tasa: TASA });
    // Venta 2: $10 → Bs 1000 efectivo + resto pago móvil
    const resto = saldoEn(10 - 1000 / TASA, 'pago_movil', TASA)!;
    await registrarVenta(d, ctx, [{ producto: p, cantidad: 2 }], { pagos: [{ medio: 'efectivo_bs', montoMoneda: 1000 }, { medio: 'pago_movil', montoMoneda: resto, referencia: '555' }], tasa: TASA });
    const r = await resumenCaja(d, (await sesionAbierta(d, 'D'))!);
    expect(r.totalUsd).toBe(25);
    expect(r.esperado).toBe(40); // 20 base + 20 cobrados
    expect(r.esperadoBs).toBe(948.15); // 1000 base − 1051.85 vuelto + 1000 cobrados
    expect(r.porMedio.pago_movil?.cantidad).toBe(1);
    const c = await cerrarCaja(d, ctx, 40, 950);
    expect(c).toMatchObject({ diferencia: 0, diferenciaBs: 1.85 });
    expect(Object.keys(totalesPorMedio((await d.ventas.toArray()).flatMap((v) => v.pagos))).sort()).toEqual(['efectivo_bs', 'efectivo_usd', 'pago_movil']);
  });
});
