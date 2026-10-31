import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { PosDB } from '../db/db';
import { aplicarPlantilla, analizarPlantilla, leerHoja } from './importar';
import { registrarEntrada, stockDe } from './inventario';
import { siguienteDe } from './productos';
import { xlsxCatalogo } from './respaldo';
import { buscarProductos } from './buscar';
import type { Contexto } from './contexto';

const ctx: Contexto = { usuario: { id: 'a', nombre: 'Admin', rol: 'admin', sedeId: 'S', activo: true }, sedeId: 'S', sedeCodigo: 'S1', dispositivoId: 'D', dispositivoCodigo: 'C1' };
const nuevaDb = () => new PosDB(`imp-${Math.random()}`);
const NodeBuffer = (globalThis as unknown as { Buffer: { from(a: ArrayBuffer): unknown } }).Buffer;
const hoja = async (ruta: string) => leerHoja(await readXlsxFile(ruta as never, { sheet: 'Catalogo' }));

describe('códigos propios', () => {
  it('sigue después del número más alto con el prefijo', () => {
    expect(siguienteDe([], 'RYG')).toBe('RYG0001');
    expect(siguienteDe(['RYG0001', 'RYG0007', 'X99', 'RYG12A'], 'RYG')).toBe('RYG0008');
    expect(siguienteDe(['ryg9999'], 'RYG')).toBe('RYG10000');
  });
});

describe('plantilla del catálogo inicial', () => {
  it('la plantilla vacía se lee sin filas', async () => {
    expect(await hoja('datos/Plantilla_catalogo_inicial.xlsx')).toEqual([]);
  });

  it('crea el catálogo con códigos automáticos y stock inicial, y rechaza filas malas', async () => {
    const d = nuevaDb();
    const filas = await hoja('test/plantilla-ejemplo.xlsx');
    expect(filas.length).toBe(8); // la fila vacía no cuenta
    const plan = await analizarPlantilla(d, filas);
    expect(plan.nuevos).toBe(5);
    expect(plan.sinPrecio).toBe(1);
    expect(plan.conteos).toBe(5);
    expect(plan.errores.map((e) => [e.fila, e.mensaje])).toEqual([
      [6, 'Precio mayor y cantidad mínima van juntos'],
      [7, 'Número no válido en STOCK CONTADO (PIEZAS)'],
      [8, 'Código repetido en el archivo'],
    ]);
    // Los códigos vacíos siguen después del más alto escrito en el archivo (RYG0010)
    expect(plan.filas.map((f) => f.codigo)).toEqual(['RYG0011', 'RYG0010', 'RYG0012', 'RYG0013', 'RYG0014']);
    expect(await aplicarPlantilla(d, ctx, plan)).toEqual([]);

    const pastilla = (await d.productos.where('codigo').equals('RYG0011').first())!;
    expect(pastilla).toMatchObject({ descripcion: 'PASTILLA FRENO DELANTERA DISCO', familia: 'FRENOS', proveedor: 'IMPORTADORA A', refProveedor: 'PF-110', precioMayor: 4, cantMinMayor: 10, stockMinimo: 8 });
    expect(await stockDe(d, 'S', pastilla.id)).toBe(40);
    const tripa = (await d.productos.where('codigo').equals('RYG0014').first())!;
    expect(tripa).toMatchObject({ costo: 2.2, precioDetal: 5 });
    expect(await stockDe(d, 'S', tripa.id)).toBe(3);
    const movs = await d.movimientos.toArray();
    expect(movs.every((m) => m.tipo === 'inicial')).toBe(true);
    // Se encuentra por moto, proveedor o referencia del proveedor
    const lista = await d.productos.toArray();
    expect(buscarProductos(lista, 'pastilla horse')[0].codigo).toBe('RYG0011');
    expect(buscarProductos(lista, 'pf-110')[0].codigo).toBe('RYG0011');
    expect(buscarProductos(lista, 'electro motos').length).toBe(0); // la fila CDI tuvo error
    expect(buscarProductos(lista, 'cauchos el llano')[0].codigo).toBe('RYG0014');
  });

  it('subir el mismo archivo dos veces no duplica productos ni stock', async () => {
    const d = nuevaDb();
    const filas = await hoja('test/plantilla-ejemplo.xlsx');
    await aplicarPlantilla(d, ctx, await analizarPlantilla(d, filas));
    const otra = await analizarPlantilla(d, filas);
    expect(otra.nuevos).toBe(0);
    expect(otra.actualizados).toBe(0);
    expect(otra.errores.filter((e) => e.mensaje.startsWith('Ya existe como')).length).toBe(4);
    await aplicarPlantilla(d, ctx, otra);
    expect(await d.productos.count()).toBe(5);
    const guaya = (await d.productos.where('codigo').equals('RYG0010').first())!;
    expect(await stockDe(d, 'S', guaya.id)).toBe(30);
  });

  it('la descarga del catálogo se vuelve a importar sin cambios; editar un precio solo cambia ese', async () => {
    const d = nuevaDb();
    await aplicarPlantilla(d, ctx, await analizarPlantilla(d, await hoja('test/plantilla-ejemplo.xlsx')));
    const blob = await xlsxCatalogo(d, ctx);
    const crudas = await readXlsxFile(NodeBuffer.from(await blob.arrayBuffer()) as never, { sheet: 'Catalogo' });
    expect(crudas[0]).toContain('STOCK EN SISTEMA (NO SE IMPORTA)');
    const filas = leerHoja(crudas);
    expect(filas.length).toBe(5);
    expect(filas.every((f) => f.stockContado === undefined)).toBe(true);
    const igual = await analizarPlantilla(d, filas);
    expect([igual.nuevos, igual.actualizados, igual.conteos, igual.errores.length]).toEqual([0, 0, 0, 0]);

    const bujia = filas.find((f) => f.codigo === 'RYG0012')!;
    bujia.precioDetal = 3;
    const cambio = await analizarPlantilla(d, filas);
    expect(cambio.actualizados).toBe(1);
    await aplicarPlantilla(d, ctx, cambio);
    expect((await d.productos.where('codigo').equals('RYG0012').first())!.precioDetal).toBe(3);
  });
});

describe('entrada de mercancía con proveedor', () => {
  it('guarda el proveedor en el movimiento y en el producto', async () => {
    const d = nuevaDb();
    await aplicarPlantilla(d, ctx, await analizarPlantilla(d, await hoja('test/plantilla-ejemplo.xlsx')));
    const p = (await d.productos.where('codigo').equals('RYG0013').first())!;
    await registrarEntrada(d, ctx, p.id, 24, { costo: 0.95, proveedor: 'distribuidora nueva', nota: 'Factura 881', actualizarCosto: true });
    const nuevo = (await d.productos.get(p.id))!;
    expect(nuevo).toMatchObject({ costo: 0.95, proveedor: 'DISTRIBUIDORA NUEVA' });
    expect(nuevo.busqueda).toContain('DISTRIBUIDORA NUEVA');
    expect(await stockDe(d, 'S', p.id)).toBe(36);
    const m = (await d.movimientos.where('productoId').equals(p.id).toArray()).find((x) => x.tipo === 'compra')!;
    expect(m).toMatchObject({ cantidad: 24, proveedor: 'DISTRIBUIDORA NUEVA', nota: 'Factura 881', costoUnitario: 0.95 });
    expect((await d.outbox.toArray()).some((x) => x.tipo === 'producto' && x.refId === p.id && (x.payload as { proveedor: string }).proveedor === 'DISTRIBUIDORA NUEVA')).toBe(true);
  });
});
