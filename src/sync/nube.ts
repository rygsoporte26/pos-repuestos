import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PosDB } from '../db/db';
import { getMeta, setMeta } from '../db/db';
import type { Rol, Usuario } from '../db/types';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** true cuando la app está configurada con Supabase (producción). */
export const MODO_NUBE = Boolean(URL && KEY);

let cliente: SupabaseClient | null = null;
export function nube(): SupabaseClient {
  if (!MODO_NUBE) throw new Error('Supabase no está configurado');
  cliente ??= createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pos-auth' } });
  return cliente;
}

/** Los vendedores sin correo entran con un usuario corto: "vendedor1" → vendedor1@pos.local */
export const aCorreo = (usuario: string) => {
  const u = usuario.trim().toLowerCase();
  return u.includes('@') ? u : `${u}@pos.local`;
};

export interface PerfilNube {
  id: string;
  nombre: string;
  rol: Rol;
  sede_id: string | null;
  activo: boolean;
  email: string | null;
}

export const perfilAUsuario = (p: PerfilNube): Usuario => ({
  id: p.id, nombre: p.nombre, rol: p.rol, sedeId: p.sede_id, activo: p.activo, email: p.email ?? undefined,
});

export class ErrorLogin extends Error {}

export async function iniciarSesion(d: PosDB, usuario: string, clave: string): Promise<Usuario> {
  const { data, error } = await nube().auth.signInWithPassword({ email: aCorreo(usuario), password: clave });
  if (error) {
    if (/invalid/i.test(error.message)) throw new ErrorLogin('Usuario o contraseña incorrectos');
    throw new ErrorLogin(navigator.onLine ? `No se pudo entrar: ${error.message}` : 'Para entrar por primera vez en este equipo se necesita internet');
  }
  const u = await cargarPerfil(d, data.user.id);
  if (!u) throw new ErrorLogin('Tu usuario no tiene perfil. Pide al administrador que lo active.');
  return u;
}

/** Baja el perfil del usuario y lo guarda local, para poder abrir la app sin internet. */
export async function cargarPerfil(d: PosDB, id: string): Promise<Usuario | null> {
  const { data, error } = await nube().from('perfiles').select('id,nombre,rol,sede_id,activo,email').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const u = perfilAUsuario(data as PerfilNube);
  await d.usuarios.put(u);
  return u;
}

/**
 * Usuario con sesión guardada en este equipo. Funciona sin internet: si no se puede
 * consultar la nube, usa el perfil guardado localmente en la última conexión.
 */
export async function usuarioActual(d: PosDB): Promise<Usuario | null> {
  const { data } = await nube().auth.getSession();
  const id = data.session?.user.id;
  if (!id) return null;
  await setMeta(d, 'ultimo_usuario', id);
  try {
    if (navigator.onLine) return await cargarPerfil(d, id);
  } catch { /* sin conexión: perfil local */ }
  return (await d.usuarios.get(id)) ?? null;
}

export async function cerrarSesion(d: PosDB) {
  await setMeta(d, 'ultimo_usuario', null);
  try { await nube().auth.signOut({ scope: 'local' }); } catch { /* sin conexión */ }
}

export const ultimoUsuario = (d: PosDB) => getMeta<string | null>(d, 'ultimo_usuario', null);
