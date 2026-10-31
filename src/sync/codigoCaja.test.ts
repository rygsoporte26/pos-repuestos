import { describe, expect, it } from 'vitest';
import { decidirCodigo, type EquipoNube } from './codigoCaja';

const eq = (id: string, codigo: string, creado_en: string): EquipoNube => ({ id, codigo, creado_en });
const base = { yoVendi: false, otroVendio: () => false };

describe('código de caja de cada PC', () => {
  it('primera vez: toma el primero libre', () => {
    expect(decidirCodigo({ ...base, miId: 'B', miCodigo: 'C1', asignado: false, equipos: [eq('A', 'C1', '1')] }).codigo).toBe('C2');
    expect(decidirCodigo({ ...base, miId: 'B', miCodigo: 'C1', asignado: false, equipos: [] }).codigo).toBe('C1');
    expect(decidirCodigo({ ...base, miId: 'C', miCodigo: 'C1', asignado: false, equipos: [eq('A', 'C1', '1'), eq('B', 'C2', '2')] }).codigo).toBe('C3');
  });
  it('dos PCs con C1 que no han vendido: se cambia el más nuevo, el otro se queda', () => {
    const equipos = [eq('A', 'C1', '2026-10-31T10:00'), eq('B', 'C1', '2026-10-31T10:05')];
    expect(decidirCodigo({ ...base, miId: 'B', miCodigo: 'C1', asignado: true, equipos }).codigo).toBe('C2');
    expect(decidirCodigo({ ...base, miId: 'A', miCodigo: 'C1', asignado: true, equipos }).codigo).toBe('C1');
    // el que ya está registrado en la nube gana sobre uno que aún no se registra
    expect(decidirCodigo({ ...base, miId: 'N', miCodigo: 'C1', asignado: true, equipos: [eq('A', 'C1', '1')] }).codigo).toBe('C2');
  });
  it('si uno ya vendió, se cambia el otro; si los dos vendieron, avisa', () => {
    const equipos = [eq('A', 'C1', '2026-10-31T10:00'), eq('B', 'C1', '2026-10-31T10:05')];
    expect(decidirCodigo({ miId: 'B', miCodigo: 'C1', asignado: true, equipos, yoVendi: true, otroVendio: () => false })).toEqual({ codigo: 'C1', aviso: null });
    expect(decidirCodigo({ miId: 'A', miCodigo: 'C1', asignado: true, equipos, yoVendi: false, otroVendio: () => true }).codigo).toBe('C2');
    const r = decidirCodigo({ miId: 'A', miCodigo: 'C1', asignado: true, equipos, yoVendi: true, otroVendio: () => true });
    expect(r.codigo).toBe('C1');
    expect(r.aviso).toContain('caja C1');
  });
});
