import { describe, expect, it } from 'vitest';
import { codigoInicial, otroConMismoCodigo, resolverEmpate, type EquipoNube } from './codigoCaja';

const AHORA = new Date('2026-10-31T15:00:00Z').getTime();
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const eq = (id: string, codigo: string, creado_en: string, ultimo = hace(1)): EquipoNube => ({ id, codigo, creado_en, ultimo_sync: ultimo });

describe('código de caja de cada PC', () => {
  it('primera vez: el primero libre de la sede', () => {
    expect(codigoInicial('B', 'C1', [eq('A', 'C1', '1')])).toBe('C2');
    expect(codigoInicial('B', 'C1', [])).toBe('C1');
    expect(codigoInicial('X', 'C1', [eq('A', 'C1', '1'), eq('B', 'C2', '2'), eq('C', 'C4', '3')])).toBe('C3');
  });
  it('dos PCs nuevos al mismo tiempo con C1: se cambia solo el que llegó después', () => {
    const equipos = [eq('A', 'C1', '2026-10-31T10:00'), eq('B', 'C1', '2026-10-31T10:00:01')];
    expect(resolverEmpate('A', 'C1', equipos)).toBe('C1');
    expect(resolverEmpate('B', 'C1', equipos)).toBe('C2');
  });
  it('después no cambia solo: avisa solo si el otro equipo está en uso', () => {
    const equipos = [eq('A', 'C2', '1', hace(1)), eq('VIEJO', 'C1', '0', hace(300))];
    expect(otroConMismoCodigo('B', 'C2', equipos, AHORA)?.id).toBe('A'); // choque real
    expect(otroConMismoCodigo('B', 'C1', equipos, AHORA)).toBeUndefined(); // equipo viejo: no estorba
    expect(otroConMismoCodigo('A', 'C2', equipos, AHORA)).toBeUndefined();
  });
});
