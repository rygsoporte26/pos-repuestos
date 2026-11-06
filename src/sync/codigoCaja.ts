// Código de caja de cada PC (C1, C2…): dos equipos de la misma sede nunca deben tener el
// mismo, porque los números de ticket (S1-C1-000001) se repetirían y la nube rechazaría uno.
//
// Reglas (1.3.3):
// - El código se asigna SOLO la primera vez que el equipo se registra: el primero libre.
// - Después nunca cambia solo. Si se repite con otro equipo, se avisa y una persona decide
//   (cambiar el código en Ajustes → Este equipo, o quitar el equipo viejo en Cajas de esta sede).

export interface EquipoNube { id: string; codigo: string; creado_en: string; ultimo_sync?: string | null; nombre?: string | null; version_app?: string | null }

/** Primer código libre: C1, C2, C3… */
export function codigoLibre(usados: Set<string>): string {
  let n = 1;
  while (usados.has(`C${n}`)) n++;
  return `C${n}`;
}

/** Código para un equipo que se registra por primera vez. */
export function codigoInicial(miId: string, deseado: string, equipos: EquipoNube[]): string {
  const usados = new Set(equipos.filter((e) => e.id !== miId).map((e) => e.codigo));
  return usados.has(deseado) ? codigoLibre(usados) : deseado;
}

/**
 * Justo después de registrarse por primera vez: si otro equipo tomó el mismo código al mismo
 * tiempo, se cambia el que se creó después (los dos aplican la misma regla y no chocan).
 */
export function resolverEmpate(miId: string, miCodigo: string, equipos: EquipoNube[]): string {
  const yo = equipos.find((e) => e.id === miId);
  const antes = equipos.find((e) => e.id !== miId && e.codigo === miCodigo
    && (!yo || e.creado_en < yo.creado_en || (e.creado_en === yo.creado_en && e.id < miId)));
  if (!antes) return miCodigo;
  return codigoLibre(new Set(equipos.filter((e) => e.id !== miId).map((e) => e.codigo)));
}

export const ACTIVO_MS = 10 * 60_000; // un PC abierto sincroniza cada 15 s

/** ¿El equipo se usó en los últimos 10 minutos? (un equipo viejo o reiniciado no cuenta) */
export const activo = (e: EquipoNube, ahora = Date.now()) => !!e.ultimo_sync && ahora - new Date(e.ultimo_sync).getTime() < ACTIVO_MS;

/**
 * Otro equipo de la sede con el mismo código que está en uso ahora mismo (para avisar; no se
 * cambia nada solo). Uno viejo con el mismo código no estorba: la numeración continúa.
 */
export function otroConMismoCodigo(miId: string, miCodigo: string, equipos: EquipoNube[], ahora = Date.now()): EquipoNube | undefined {
  return equipos.find((e) => e.id !== miId && e.codigo === miCodigo && activo(e, ahora));
}

export const textoChoque = (codigo: string, otro: EquipoNube, fecha: (iso: string) => string) =>
  `Otro equipo también está registrado como caja ${codigo}${otro.ultimo_sync ? ` (último uso ${fecha(otro.ultimo_sync)})` : ''}: los tickets se repetirían. `
  + 'Cambia el código en Ajustes → Este equipo, o quita el equipo viejo en Ajustes → Cajas de esta sede.';
