import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { PosDB } from '../db/db';
import { filaAProducto } from '../db/seed';
import catalogo from '../data/catalogo-gp.json';
import { aplicarPlantilla, analizarPlantilla, leerHoja } from './importar';
import { stockDe } from './inventario';
import type { Contexto } from './contexto';

const ctx: Contexto = { usuario: { id: 'a', nombre: 'Admin', rol: 'admin', sedeId: 'S', activo: true }, sedeId: 'S', sedeCodigo: 'S1', dispositivoId: 'D', dispositivoCodigo: 'C1' };

describe('importar plantilla Excel', () => {
  it('lee la plantilla real, valida y aplica precios y conteo', async () => {
    const d = new PosDB(`imp-${Math.random()}`);
    await d.productos.bulkAdd((catalogo as Parameters<typeof filaAProducto>[0][]).map(filaAProducto));
    const filas = leerHoja(await readXlsxFile('test/plantilla-ejemplo.xlsx', { sheet: 'Conteo' }));
    expect(filas.length).toBe(1207);
    expect(filas[0]).toMatchObject({ codigo: '1462', precioDetal: 5, precioMayor: 4, cantMinMayor: 10, stockContado: 37 });
    const plan = await analizarPlantilla(d, filas);
    // fila 1462 completa; 1464 detal bajo costo (aviso, no bloquea); 1466 mayor>=detal (aviso); 1465 sin detal → no cambia precio
    expect(plan.precios).toBe(3);
    expect(plan.conteos).toBe(2);
    const errores = await aplicarPlantilla(d, ctx, plan);
    expect(errores).toEqual([]);
    const p = (await d.productos.where('codigo').equals('1462').first())!;
    expect(p.precioMayor).toBe(4);
    expect(await stockDe(d, 'S', p.id)).toBe(37);
  });
});
