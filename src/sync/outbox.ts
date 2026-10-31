import type { PosDB } from '../db/db';
import type { TipoOutbox } from '../db/types';

/** Versión del formato de los payloads. Subirla si cambia su forma. */
export const FORMATO_OUTBOX = 1;

/**
 * Cola de cambios pendientes de subir a la nube. Toda operación que escribe datos
 * oficiales (venta, anulación, movimiento, producto, caja) deja aquí su registro en
 * la MISMA transacción, así nunca hay una venta guardada sin su envío pendiente.
 * El sincronizador (src/sync/motor.ts) la vacía en orden cuando hay internet.
 */
export async function encolar(d: PosDB, tipo: TipoOutbox, refId: string, payload: unknown) {
  await d.outbox.add({ tipo, refId, payload, formato: FORMATO_OUTBOX, creadoEn: new Date().toISOString(), intentos: 0, error: null });
  // Avisa al sincronizador (si está activo) para subir pronto.
  if (typeof window !== 'undefined') setTimeout(() => window.dispatchEvent(new Event('pos-outbox')), 0);
}

export const pendientes = (d: PosDB) => d.outbox.count();
