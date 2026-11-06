import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { actualizarDispositivo, db, getMeta, setMeta } from './db/db';
import { inicializar, inicializarNube, NEGOCIO_POR_DEFECTO } from './db/seed';
import type { Negocio, Usuario } from './db/types';
import { puede, type Accion, type Contexto } from './domain/contexto';
import { AppCtx, Campo, useToast, type Pagina } from './ui/components/ui';
import { Vender } from './ui/pages/Vender';
import { Caja } from './ui/pages/Caja';
import { Ventas } from './ui/pages/Ventas';
import { Mayor } from './ui/pages/Mayor';
import { Productos } from './ui/pages/Productos';
import { Inventario } from './ui/pages/Inventario';
import { Panel } from './ui/pages/Panel';
import { Ajustes } from './ui/pages/Ajustes';
import { MODO_NUBE, cerrarSesion, iniciarSesion, usuarioActual } from './sync/nube';
import { arrancarSync, leerEstado } from './sync/motor';
import { hora, num2 } from './domain/util';
import { tasaDeHoy } from './domain/tasa';
import { useTasa } from './ui/hooks';

declare const __APP_VERSION__: string;
const MODO_DEMO = !MODO_NUBE;

const PAGINAS: { id: Pagina; nombre: string; accion: Accion }[] = [
  { id: 'vender', nombre: 'Vender', accion: 'vender' },
  { id: 'caja', nombre: 'Caja', accion: 'caja' },
  { id: 'ventas', nombre: 'Ventas', accion: 'ver_ventas' },
  { id: 'mayor', nombre: 'Mayor', accion: 'mayor' },
  { id: 'productos', nombre: 'Productos', accion: 'editar_productos' },
  { id: 'inventario', nombre: 'Inventario', accion: 'mover_inventario' },
  { id: 'panel', nombre: 'Panel', accion: 'ver_panel' },
  { id: 'ajustes', nombre: 'Ajustes', accion: 'ver_ajustes' },
];
const inicio = (u: Usuario): Pagina => (u.rol === 'supervisor' ? 'panel' : 'vender');

const leer = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardar = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

type Dispositivo = { id: string; codigo: string; sedeId: string | null };

export function App() {
  const [listo, setListo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usuario, setUsuario] = useState<Usuario | null | undefined>(undefined);
  const [pagina, setPagina] = useState<Pagina>('vender');
  const [rev, setRev] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const ctxRef = useRef<Contexto | null>(null);

  // Arranque: base local + usuario con sesión guardada.
  useEffect(() => {
    (async () => {
      if (MODO_NUBE) {
        await inicializarNube(db);
        setUsuario(await usuarioActual(db).catch(() => null));
      } else {
        await inicializar(db);
        const id = leer('pos_usuario');
        setUsuario((id && (await db.usuarios.get(id))) || null);
      }
      setListo(true);
    })().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const datos = useLiveQuery(async () => {
    if (!listo) return null;
    const dispositivo = await getMeta<Dispositivo | null>(db, 'dispositivo', null);
    const negocio = await getMeta<Negocio>(db, 'negocio', NEGOCIO_POR_DEFECTO);
    const sedes = await db.sedes.toArray();
    const sedeElegida = await getMeta<string | null>(db, 'sede_supervisor', null);
    const usuarios = await db.usuarios.toArray();
    return { dispositivo, negocio, sedes, sedeElegida, usuarios };
  }, [listo, rev]);

  // El usuario puede cambiar en la nube (rol, activo): se toma la versión local más reciente.
  const u = usuario && datos ? datos.usuarios.find((x) => x.id === usuario.id) ?? usuario : usuario;
  const sedeId = u ? u.sedeId ?? datos?.sedeElegida ?? datos?.sedes[0]?.id ?? null : null;
  const sede = datos?.sedes.find((s) => s.id === sedeId);

  // El PC pertenece a la sede de quien vende en él.
  useEffect(() => {
    if (datos?.dispositivo && u?.sedeId && datos.dispositivo.sedeId !== u.sedeId) {
      void actualizarDispositivo(db, { sedeId: u.sedeId }); // solo la sede: no pisa el código de caja
    }
  }, [datos?.dispositivo, u?.sedeId]);

  const ctx: Contexto | null = u && u.activo && sede && datos?.dispositivo
    ? { usuario: u, sedeId: sede.id, sedeCodigo: sede.codigo, dispositivoId: datos.dispositivo.id, dispositivoCodigo: datos.dispositivo.codigo }
    : null;
  ctxRef.current = ctx;

  // Sincronización con la nube mientras haya un usuario activo.
  const activo = MODO_NUBE && !!u?.activo;
  useEffect(() => {
    if (!activo) return;
    return arrancarSync(db, () => ctxRef.current ?? (u ? { usuario: u, sedeId: '', sedeCodigo: '', dispositivoId: datos?.dispositivo?.id ?? '', dispositivoCodigo: 'C1' } : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, u?.id]);

  // Apenas se conoce la sede (al entrar), se sincroniza: así el equipo recibe su código de caja de inmediato.
  useEffect(() => {
    if (activo && ctx?.sedeId) window.dispatchEvent(new Event('pos-outbox'));
  }, [activo, ctx?.sedeId]);

  const irA = useCallback((p: Pagina) => setPagina(p), []);
  const salir = async () => {
    if (MODO_NUBE) await cerrarSesion(db); else guardar('pos_usuario', null);
    setUsuario(null);
  };

  if (error) return <div className="main"><div className="alert bad">No se pudo abrir la base local: {error}</div></div>;
  if (!listo || !datos || usuario === undefined) return <div className="main"><div className="muted">Cargando…</div></div>;

  if (!u) {
    return (
      <Marco>
        {MODO_NUBE
          ? <LoginNube onOk={(x) => { setUsuario(x); setPagina(inicio(x)); }} />
          : <LoginDemo usuarios={datos.usuarios} onOk={(x) => { guardar('pos_usuario', x.id); setUsuario(x); setPagina(inicio(x)); }} />}
      </Marco>
    );
  }
  if (!u.activo) {
    return (
      <Marco>
        <div className="login panel">
          <h1>Usuario pendiente</h1>
          <p style={{ margin: 0 }}>Tu usuario <strong>{u.email ?? u.nombre}</strong> existe pero todavía no está activo. Pide al administrador que lo active en Ajustes → Usuarios y le asigne rol y sede.</p>
          <div><button className="btn" onClick={salir}>Salir</button></div>
        </div>
      </Marco>
    );
  }
  if (!ctx) {
    return (
      <Marco>
        <div className="login panel">
          <h1>Descargando datos…</h1>
          <p className="muted" style={{ margin: 0 }}>La primera vez este equipo baja el catálogo y las sedes desde la nube. Necesita internet.</p>
          <SyncBadge irA={() => {}} />
          <div><button className="btn" onClick={salir}>Salir</button></div>
        </div>
      </Marco>
    );
  }

  const visibles = PAGINAS.filter((p) => puede(u.rol, p.accion));
  const actual = visibles.some((p) => p.id === pagina) ? pagina : inicio(u);

  return (
    <AppCtx.Provider value={{ ctx, negocio: datos.negocio, irA }}>
      <div className="app">
        <header className="topbar">
          <span className="brand">POS Repuestos</span>
          <nav className="nav" aria-label="Secciones">
            {visibles.map((p) => <button key={p.id} aria-current={actual === p.id ? 'page' : undefined} onClick={() => setPagina(p.id)}>{p.nombre}</button>)}
          </nav>
          <div className="who">
            <span>{u.nombre} · {ctx.sedeCodigo}{puede(u.rol, 'caja') ? `-${ctx.dispositivoCodigo}` : ''}</span>
            {u.rol === 'supervisor' && datos.sedes.length > 1 && (
              <select aria-label="Sede" className="input" style={{ width: 'auto', padding: '2px 6px' }} value={ctx.sedeId}
                onChange={async (e) => { await setMeta(db, 'sede_supervisor', e.target.value); setRev((r) => r + 1); }}>
                {datos.sedes.map((s) => <option key={s.id} value={s.id}>{s.codigo} · {s.nombre}</option>)}
              </select>
            )}
            <TasaBadge irA={puede(u.rol, 'ajustes') ? () => setPagina('ajustes') : undefined} />
            {MODO_NUBE ? <SyncBadge irA={() => setPagina('ajustes')} /> : <span className={`badge ${online ? 'good' : 'warn'}`}>{online ? 'En línea' : 'Sin internet'}</span>}
            <button onClick={salir}>Salir</button>
          </div>
        </header>
        {MODO_DEMO && <div className="demo-band">Modo demo: todo se guarda solo en este navegador. La conexión con la nube se activa al configurar Supabase.</div>}
        <main className="main">
          {actual === 'vender' && <Vender />}
          {actual === 'caja' && <Caja />}
          {actual === 'ventas' && <Ventas />}
          {actual === 'mayor' && <Mayor />}
          {actual === 'productos' && <Productos />}
          {actual === 'inventario' && <Inventario />}
          {actual === 'panel' && <Panel />}
          {actual === 'ajustes' && <Ajustes onCambio={() => setRev((r) => r + 1)} />}
        </main>
        <footer className="footer">Versión {__APP_VERSION__}{MODO_DEMO ? ' · demo' : ''}</footer>
      </div>
    </AppCtx.Provider>
  );
}

function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <header className="topbar"><span className="brand">POS Repuestos</span></header>
      {MODO_DEMO && <div className="demo-band">Modo demo: todo se guarda solo en este navegador. Prueba con datos inventados.</div>}
      <main className="main">{children}</main>
    </div>
  );
}

function LoginDemo({ usuarios, onOk }: { usuarios: Usuario[]; onOk: (u: Usuario) => void }) {
  return (
    <div className="login panel">
      <h1>¿Quién va a usar el sistema?</h1>
      <div className="muted small">Cada persona ve solo lo que le corresponde: el vendedor vende y cierra su caja; el administrador además carga precios, inventario y anula ventas; el supervisor ve todo desde Colombia.</div>
      <div className="user-pick">
        {usuarios.filter((u) => u.activo).map((u) => (
          <button key={u.id} onClick={() => onOk(u)}>
            <span>{u.nombre}</span>
            <span className={`badge ${u.rol === 'admin' ? 'accent' : u.rol === 'supervisor' ? 'mayor' : ''}`}>{u.rol === 'admin' ? 'Administrador' : u.rol === 'supervisor' ? 'Supervisor' : 'Vendedor'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LoginNube({ onOk }: { onOk: (u: Usuario) => void }) {
  const [usuario, setUsuarioTxt] = useState('');
  const [clave, setClave] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="login panel" onSubmit={async (e) => {
      e.preventDefault();
      setEnviando(true); setError(null);
      try { onOk(await iniciarSesion(db, usuario, clave)); } catch (x) { setError(x instanceof Error ? x.message : String(x)); }
      setEnviando(false);
    }}>
      <h1>Entrar</h1>
      <Campo label="Usuario o correo"><input id="login-usuario" className="input search" autoComplete="username" value={usuario} onChange={(e) => setUsuarioTxt(e.target.value)} autoFocus /></Campo>
      <Campo label="Contraseña"><input id="login-clave" className="input search" type="password" autoComplete="current-password" value={clave} onChange={(e) => setClave(e.target.value)} /></Campo>
      {error && <div className="alert bad">{error}</div>}
      <div className="muted small">La primera vez en cada equipo se necesita internet. Después la caja abre aunque no haya conexión.</div>
      <div><button className="btn primary big" type="submit" disabled={enviando || !usuario || !clave}>{enviando ? 'Entrando…' : 'Entrar'}</button></div>
    </form>
  );
}

/** Estado de la sincronización: pendientes, último envío y errores. */
export function SyncBadge({ irA }: { irA: () => void }) {
  const estado = useLiveQuery(() => leerEstado(db), []);
  const pendientes = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  const avisar = useToast();
  const prevError = useRef<string | null>(null);
  useEffect(() => {
    if (estado?.error && estado.bloqueado && estado.error !== prevError.current) avisar(estado.error, true);
    prevError.current = estado?.error ?? null;
  }, [estado?.error, estado?.bloqueado, avisar]);
  if (!estado) return null;
  let clase = 'good', texto = estado.ultimoOk ? `Al día ${hora(estado.ultimoOk)}` : 'Sin sincronizar';
  if (estado.enCurso) { clase = 'accent'; texto = 'Sincronizando…'; }
  else if (estado.bloqueado) { clase = 'bad'; texto = 'Error al subir'; }
  else if (pendientes > 0) { clase = 'warn'; texto = `${pendientes} por subir`; }
  else if (estado.error) { clase = 'warn'; texto = 'Sin conexión'; }
  return <button className={`badge sync-badge ${clase}`} style={{ border: 0, cursor: 'pointer' }} title={estado.error ?? ''} onClick={irA}>{texto}</button>;
}

/** Tasa BCV vigente; en ámbar si no es de hoy. */
function TasaBadge({ irA }: { irA?: () => void }) {
  const tasa = useTasa();
  if (tasa === undefined) return null;
  const hoy = tasaDeHoy(tasa);
  return (
    <button className={`badge tasa-badge ${hoy ? '' : 'warn'}`} style={{ border: 0, cursor: irA ? 'pointer' : 'default' }} onClick={irA}
      title={tasa ? `Tasa cargada el ${tasa.fecha}` : 'Sin tasa BCV'}>
      {tasa ? `Tasa ${num2(tasa.valor)}` : 'Sin tasa'}
    </button>
  );
}
