// Código de caja de cada PC (C1, C2…): dos equipos de la misma sede nunca deben tener el
// mismo, porque los números de ticket (S1-C1-000001) se repetirían y la nube rechazaría uno.

export interface EquipoNube { id: string; codigo: string; creado_en: string }

export interface DecisionCodigo {
  codigo: string; // el código que debe usar este equipo
  aviso: string | null; // choque que no se puede arreglar solo (los dos equipos ya vendieron)
}

/** Primer código libre: C1, C2, C3… */
export function codigoLibre(usados: Set<string>): string {
  let n = 1;
  while (usados.has(`C${n}`)) n++;
  return `C${n}`;
}

/**
 * Decide el código de este equipo con lo que hay en la nube.
 * - Primera vez: si el código ya lo usa otro equipo, toma el primero libre.
 * - Si después aparece otro equipo con el mismo código (se registraron a la vez, o se
 *   limpió la base): se cambia el que todavía no ha vendido; si ninguno vendió, el más nuevo.
 * - Si los dos ya vendieron con ese código, no se cambia nada y se avisa.
 */
export function decidirCodigo(p: {
  miId: string; miCodigo: string; asignado: boolean; equipos: EquipoNube[];
  yoVendi: boolean; otroVendio: (id: string) => boolean;
}): DecisionCodigo {
  const ajenos = p.equipos.filter((e) => e.id !== p.miId);
  const usados = new Set(ajenos.map((e) => e.codigo));
  const choque = ajenos.find((e) => e.codigo === p.miCodigo);
  if (!choque) return { codigo: p.miCodigo, aviso: null };
  if (!p.asignado) return { codigo: codigoLibre(usados), aviso: null };
  const yo = p.equipos.find((e) => e.id === p.miId);
  const elVendio = p.otroVendio(choque.id);
  const soyMasNuevo = !yo || yo.creado_en > choque.creado_en || (yo.creado_en === choque.creado_en && p.miId > choque.id);
  if (!p.yoVendi && (elVendio || soyMasNuevo)) return { codigo: codigoLibre(usados), aviso: null };
  if (p.yoVendi && elVendio) {
    return { codigo: p.miCodigo, aviso: `Otro equipo de esta sede también es la caja ${p.miCodigo} y los dos ya vendieron: los tickets se repiten. Avisa al administrador.` };
  }
  return { codigo: p.miCodigo, aviso: null }; // el otro equipo se cambia solo en su próxima sincronización
}
