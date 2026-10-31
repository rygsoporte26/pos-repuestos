import type { PosDB } from '../db/db';
import { catalogoGP } from '../db/seed';
import { ErrorNegocio, exigir, type Contexto } from '../domain/contexto';
import { FORMATO_OUTBOX } from './outbox';
import { nube } from './nube';

/** ¿La nube ya tiene productos? (para ofrecer la carga inicial solo una vez) */
export async function productosEnNube(): Promise<number> {
  const { count, error } = await nube().from('productos').select('id', { count: 'exact', head: true });
  if (error) throw new ErrorNegocio(`No se pudo consultar la nube: ${error.message}`);
  return count ?? 0;
}

/** Carga inicial: los 1.207 productos del importador GP, sin precios ni stock. */
export async function subirCatalogoInicial(d: PosDB, ctx: Contexto): Promise<number> {
  exigir(ctx, 'editar_productos');
  if (!navigator.onLine) throw new ErrorNegocio('Se necesita internet para la carga inicial');
  if ((await productosEnNube()) > 0) throw new ErrorNegocio('La nube ya tiene productos: la carga inicial solo se hace una vez');
  const prods = await catalogoGP();
  const ahora = new Date().toISOString();
  await d.transaction('rw', [d.productos, d.outbox], async () => {
    await d.productos.bulkPut(prods);
    await d.outbox.bulkAdd(prods.map((p) => ({ tipo: 'producto' as const, refId: p.id, payload: p, formato: FORMATO_OUTBOX, creadoEn: ahora, intentos: 0, error: null })));
  });
  window.dispatchEvent(new Event('pos-outbox'));
  return prods.length;
}
