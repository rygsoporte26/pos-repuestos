import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import readXlsxFile from 'read-excel-file';
import { db, getMeta, setMeta } from '../../db/db';
import type { Negocio, Rol, Usuario } from '../../db/types';
import { exigir, puede } from '../../domain/contexto';
import { recalcularStock } from '../../domain/inventario';
import { aplicarPlantilla, analizarPlantilla, leerHoja, type PlanImportacion } from '../../domain/importar';
import { csvProductos, csvVentas, descargar } from '../../domain/respaldo';
import { diaLocal, fechaHora, num2, parseNum, uuid } from '../../domain/util';
import { consultarTasaBcv, guardarTasa, tasaDeHoy } from '../../domain/tasa';
import { useTasa } from '../hooks';
import { MODO_NUBE, nube } from '../../sync/nube';
import { descartarCambio, leerEstado, nombreTipo, rebajarTodo, sincronizar } from '../../sync/motor';
import { productosEnNube, subirCatalogoInicial } from '../../sync/catalogo';
import { Campo, useAccion, useApp, useToast } from '../components/ui';

const ROLES: Record<Rol, string> = { vendedor: 'Vendedor', admin: 'Administrador', supervisor: 'Supervisor' };

export function Ajustes({ onCambio }: { onCambio: () => void }) {
  const { ctx } = useApp();
  const admin = puede(ctx.usuario.rol, 'ajustes');
  return (
    <>
      <h1>Ajustes</h1>
      {admin && <TasaDelDia />}
      {MODO_NUBE && <Sincronizacion />}
      {MODO_NUBE && puede(ctx.usuario.rol, 'editar_productos') && <CargaInicial />}
      {puede(ctx.usuario.rol, 'editar_productos') && <ImportarPlantilla />}
      {admin && <Respaldo />}
      {admin && <DatosNegocio onCambio={onCambio} />}
      {admin && puede(ctx.usuario.rol, 'caja') && <EsteEquipo onCambio={onCambio} />}
      {admin && (MODO_NUBE ? <UsuariosNube /> : <UsuariosDemo />)}
      {admin && <Mantenimiento />}
      {!admin && !MODO_NUBE && <div className="muted">Los ajustes los maneja el administrador.</div>}
    </>
  );
}

function Sincronizacion() {
  const { ctx } = useApp();
  const accion = useAccion();
  const estado = useLiveQuery(() => leerEstado(db), []);
  const cola = useLiveQuery(() => db.outbox.orderBy('seq').limit(5).toArray(), []) ?? [];
  const pendientes = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  const [confirmar, setConfirmar] = useState<number | null>(null);
  const bloqueado = cola.find((x) => x.seq === estado?.bloqueado);
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Sincronización con la nube</h2>
      <table><tbody>
        <tr><td>Última sincronización completa</td><td className="num">{estado?.ultimoOk ? fechaHora(estado.ultimoOk) : 'Nunca'}</td></tr>
        <tr><td>Cambios guardados en este equipo, por subir</td><td className="num">{pendientes}</td></tr>
        <tr><td>Estado</td><td className="num">{estado?.enCurso ? 'Sincronizando…' : estado?.error ?? 'Al día'}</td></tr>
      </tbody></table>
      <div><button className="btn" onClick={() => accion(() => sincronizar(db, ctx), 'Sincronización terminada')}>Sincronizar ahora</button></div>
      {bloqueado && (
        <div className="alert bad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>La nube rechazó este cambio y los siguientes esperan:</strong>
          <span>{nombreTipo(bloqueado.tipo)} del {fechaHora(bloqueado.creadoEn)} · {bloqueado.error}</span>
          <span className="small">Si es un error que no se puede corregir, el administrador puede descartarlo. Queda guardado en el historial de descartados de este equipo.</span>
          {puede(ctx.usuario.rol, 'anular') && (confirmar !== bloqueado.seq
            ? <div><button className="btn danger" onClick={() => setConfirmar(bloqueado.seq!)}>Descartar este cambio</button></div>
            : <div className="row center"><span>¿Descartar? No se subirá a la nube.</span><button className="btn" onClick={() => setConfirmar(null)}>No</button>
                <button className="btn danger" onClick={() => accion(async () => { await descartarCambio(db, bloqueado.seq!); setConfirmar(null); await sincronizar(db, ctx); }, 'Cambio descartado')}>Sí, descartar</button></div>)}
        </div>
      )}
    </section>
  );
}

function CargaInicial() {
  const { ctx } = useApp();
  const accion = useAccion();
  const locales = useLiveQuery(() => db.productos.count(), []) ?? 0;
  const [enNube, setEnNube] = useState<number | null>(null);
  if (locales > 0 && enNube === null) return null;
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Catálogo inicial</h2>
      <div className="muted small">Se hace una sola vez, en la instalación: sube a la nube los 1.207 productos de la lista GP Motocycles (código, descripción, familia, moto y costo, sin precios ni stock).</div>
      <div className="row">
        <button className="btn" onClick={() => accion(async () => setEnNube(await productosEnNube()))}>Revisar la nube</button>
        {enNube !== null && <span className="muted">{enNube === 0 ? 'La nube no tiene productos.' : `La nube ya tiene ${enNube} productos: no hace falta la carga inicial.`}</span>}
        {enNube === 0 && <button className="btn primary" onClick={() => accion(async () => { const n = await subirCatalogoInicial(db, ctx); setEnNube(n); }, 'Catálogo cargado: subiendo a la nube')}>Cargar catálogo GP</button>}
      </div>
    </section>
  );
}

function ImportarPlantilla() {
  const { ctx } = useApp();
  const avisar = useToast();
  const [plan, setPlan] = useState<PlanImportacion | null>(null);
  const [avance, setAvance] = useState<number | null>(null);
  const [errores, setErrores] = useState<{ codigo: string; mensaje: string }[]>([]);
  async function leer(f: File) {
    try {
      const conteo = await readXlsxFile(f, { sheet: 'Conteo' });
      let nuevos: unknown[][] = [];
      try { nuevos = await readXlsxFile(f, { sheet: 'Nuevos productos' }); } catch { /* hoja opcional */ }
      setPlan(await analizarPlantilla(db, [...leerHoja(conteo), ...leerHoja(nuevos, true)]));
      setErrores([]);
    } catch (e) {
      avisar(`No se pudo leer el archivo. Usa la plantilla "Plantilla_conteo_y_precios.xlsx" (hoja Conteo). ${e instanceof Error ? e.message : ''}`, true);
    }
  }
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Importar plantilla de precios y conteo</h2>
      <div className="muted small">Sube la plantilla Excel llena (hoja “Conteo” y opcionalmente “Nuevos productos”). Se actualizan los precios de las filas que tengan precio detal y se registra el stock contado como conteo físico.</div>
      <input id="archivo-plantilla" type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && leer(e.target.files[0])} />
      {plan && (
        <div className="alert info" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span><strong>{plan.precios}</strong> productos con precios nuevos · <strong>{plan.conteos}</strong> con stock contado · <strong>{plan.nuevos}</strong> productos nuevos</span>
          {plan.noEncontrados.length > 0 && <span>{plan.noEncontrados.length} códigos no existen en el catálogo: {plan.noEncontrados.slice(0, 10).join(', ')}{plan.noEncontrados.length > 10 ? '…' : ''}</span>}
          {plan.errores.length > 0 && <span>{plan.errores.length} filas con errores: {plan.errores.slice(0, 5).map((x) => `${x.codigo} (${x.mensaje})`).join('; ')}</span>}
          {avance === null
            ? <div><button className="btn primary" disabled={!plan.filas.length} onClick={async () => {
                setAvance(0);
                const err = await aplicarPlantilla(db, ctx, plan, setAvance).catch((e) => [{ codigo: '-', mensaje: String(e) }]);
                setErrores(err); setAvance(null); setPlan(null);
                avisar(err.length ? `Importación terminada con ${err.length} errores` : 'Importación terminada', err.length > 0);
              }}>Aplicar {plan.filas.length} filas</button></div>
            : <span>Aplicando… {avance} de {plan.filas.length}</span>}
        </div>
      )}
      {errores.length > 0 && (
        <div className="alert bad">Filas no aplicadas: {errores.slice(0, 20).map((x) => `${x.codigo}: ${x.mensaje}`).join(' · ')}</div>
      )}
    </section>
  );
}

function Respaldo() {
  const { ctx } = useApp();
  const hoy = diaLocal();
  const [desde, setDesde] = useState(hoy.slice(0, 8) + '01');
  const [hasta, setHasta] = useState(hoy);
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Respaldo en Excel (CSV)</h2>
      <div className="muted small">Descarga una copia que se abre en Excel. Recomendado una vez por semana.</div>
      <div className="row">
        <button className="btn" onClick={async () => descargar(`productos-${hoy}.csv`, await csvProductos(db, ctx))}>Productos y stock</button>
        <Campo label="Ventas desde"><input id="resp-desde" type="date" className="input" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="hasta"><input id="resp-hasta" type="date" className="input" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <button className="btn" onClick={async () => descargar(`ventas-${desde}-a-${hasta}.csv`, await csvVentas(db, desde, hasta))}>Ventas</button>
      </div>
    </section>
  );
}

function DatosNegocio({ onCambio }: { onCambio: () => void }) {
  const { ctx, negocio } = useApp();
  const accion = useAccion();
  const [n, setN] = useState<Negocio>(negocio);
  return (
    <form className="panel" style={{ maxWidth: 760 }} onSubmit={async (e) => {
      e.preventDefault();
      await accion(async () => {
        exigir(ctx, 'ajustes');
        if (MODO_NUBE) {
          const { error } = await nube().from('config').upsert({ clave: 'negocio', valor: n });
          if (error) throw new Error(`No se pudo guardar en la nube (¿hay internet?): ${error.message}`);
        }
        await setMeta(db, 'negocio', n);
        onCambio();
      }, 'Datos del negocio guardados');
    }}>
      <h2>Datos del negocio (aparecen en el ticket)</h2>
      <div className="row">
        <Campo label="Nombre"><input id="neg-nombre" className="input" value={n.nombre} onChange={(e) => setN({ ...n, nombre: e.target.value })} /></Campo>
        <Campo label="Teléfono"><input id="neg-tel" className="input" value={n.telefono} onChange={(e) => setN({ ...n, telefono: e.target.value })} /></Campo>
      </div>
      <Campo label="Dirección"><input id="neg-dir" className="input" value={n.direccion} onChange={(e) => setN({ ...n, direccion: e.target.value })} /></Campo>
      <Campo label="Mensaje al pie del ticket"><input id="neg-msg" className="input" value={n.mensajeTicket} onChange={(e) => setN({ ...n, mensajeTicket: e.target.value })} /></Campo>
      <div><button className="btn primary" type="submit">Guardar</button></div>
    </form>
  );
}

function EsteEquipo({ onCambio }: { onCambio: () => void }) {
  const { ctx } = useApp();
  const accion = useAccion();
  const avisar = useToast();
  const [caja, setCaja] = useState(ctx.dispositivoCodigo);
  return (
    <form className="panel" style={{ maxWidth: 760 }} onSubmit={async (e) => {
      e.preventDefault();
      const c = caja.trim().toUpperCase();
      if (!/^C\d{1,2}$/.test(c)) { avisar('El código de caja debe ser C seguido de un número, ej. C2', true); return; }
      await accion(async () => {
        const d = await getMeta<{ id: string; codigo: string; sedeId: string | null }>(db, 'dispositivo', { id: uuid(), codigo: 'C1', sedeId: ctx.sedeId });
        await setMeta(db, 'dispositivo', { ...d, codigo: c });
        onCambio();
      }, `Este equipo ahora es la caja ${c}`);
    }}>
      <h2>Este equipo</h2>
      <div className="muted small">Cada PC de venta debe tener un código distinto (C1, C2…). Va en el número de ticket: {ctx.sedeCodigo}-{caja || 'C1'}-000001. {MODO_NUBE ? 'Se asigna solo la primera vez que el equipo se conecta; cámbialo solo si hace falta, antes de la primera venta.' : 'Cámbialo antes de la primera venta.'}</div>
      <div className="row"><Campo label="Código de caja"><input id="cod-caja" className="input" value={caja} onChange={(e) => setCaja(e.target.value)} /></Campo><button className="btn" type="submit">Guardar</button></div>
    </form>
  );
}

function UsuariosNube() {
  const { ctx } = useApp();
  const accion = useAccion();
  const usuarios = useLiveQuery(() => db.usuarios.toArray(), []) ?? [];
  const sedes = useLiveQuery(() => db.sedes.toArray(), []) ?? [];
  const editable = puede(ctx.usuario.rol, 'usuarios');
  async function guardarU(u: Usuario, cambios: Partial<{ nombre: string; rol: Rol; sede_id: string | null; activo: boolean }>) {
    await accion(async () => {
      exigir(ctx, 'usuarios');
      const { error } = await nube().from('perfiles').update(cambios).eq('id', u.id);
      if (error) throw new Error(`No se pudo guardar (¿hay internet?): ${error.message}`);
      await db.usuarios.update(u.id, {
        ...(cambios.nombre !== undefined && { nombre: cambios.nombre }), ...(cambios.rol && { rol: cambios.rol }),
        ...(cambios.sede_id !== undefined && { sedeId: cambios.sede_id }), ...(cambios.activo !== undefined && { activo: cambios.activo }),
      });
    }, 'Usuario actualizado');
  }
  return (
    <section className="panel" style={{ maxWidth: 900 }}>
      <h2>Usuarios</h2>
      <div className="muted small">Para crear un usuario: en Supabase, Authentication → Users → Add user (correo y contraseña, “Auto Confirm User”). Para vendedores sin correo usa <span className="mono">nombre@pos.local</span>; entran escribiendo solo el nombre. El usuario aparece aquí como pendiente: actívalo y asígnale rol y sede.</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Sede</th><th>Estado</th></tr></thead>
        <tbody>{usuarios.sort((a, b) => Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre)).map((u) => (
          <FilaUsuario key={u.id} u={u} sedes={sedes} editable={editable && u.id !== ctx.usuario.id} onGuardar={guardarU} />
        ))}</tbody>
      </table></div>
    </section>
  );
}

function FilaUsuario({ u, sedes, editable, onGuardar }: { u: Usuario; sedes: { id: string; codigo: string; nombre: string }[]; editable: boolean; onGuardar: (u: Usuario, c: Partial<{ nombre: string; rol: Rol; sede_id: string | null; activo: boolean }>) => Promise<void> }) {
  const [nombre, setNombre] = useState(u.nombre);
  return (
    <tr>
      <td className="mono small">{u.email?.replace('@pos.local', '') ?? ''}</td>
      <td>{editable ? <input className="input" aria-label={`Nombre de ${u.email}`} value={nombre} onChange={(e) => setNombre(e.target.value)} onBlur={() => nombre.trim() && nombre !== u.nombre && onGuardar(u, { nombre: nombre.trim() })} /> : u.nombre}</td>
      <td>{editable ? (
        <select className="input" aria-label={`Rol de ${u.email}`} value={u.rol} onChange={(e) => onGuardar(u, { rol: e.target.value as Rol, ...(e.target.value === 'supervisor' ? { sede_id: null } : {}) })}>
          {(Object.keys(ROLES) as Rol[]).map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
        </select>) : ROLES[u.rol]}</td>
      <td>{editable && u.rol !== 'supervisor' ? (
        <select className="input" aria-label={`Sede de ${u.email}`} value={u.sedeId ?? ''} onChange={(e) => onGuardar(u, { sede_id: e.target.value || null })}>
          <option value="">Elegir…</option>
          {sedes.map((s) => <option key={s.id} value={s.id}>{s.codigo} · {s.nombre}</option>)}
        </select>) : u.rol === 'supervisor' ? 'Todas' : sedes.find((s) => s.id === u.sedeId)?.codigo ?? '—'}</td>
      <td>{editable ? (
        <button className={`btn ${u.activo ? 'ghost' : 'primary'}`} disabled={!u.activo && u.rol !== 'supervisor' && !u.sedeId}
          onClick={() => onGuardar(u, { activo: !u.activo })}>{u.activo ? 'Desactivar' : 'Activar'}</button>
      ) : u.activo ? <span className="badge good">Activo</span> : <span className="badge warn">Pendiente</span>}</td>
    </tr>
  );
}

function UsuariosDemo() {
  const { ctx } = useApp();
  const accion = useAccion();
  const usuarios = useLiveQuery(() => db.usuarios.toArray(), []) ?? [];
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoRol, setNuevoRol] = useState<Rol>('vendedor');
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Usuarios</h2>
      <div className="muted small">En la versión con nube cada usuario entra con usuario y contraseña. En la demo basta elegirlo en la pantalla de entrada.</div>
      <table>
        <thead><tr><th>Nombre</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
        <tbody>{usuarios.map((u) => (
          <tr key={u.id}><td>{u.nombre}</td><td>{ROLES[u.rol]}</td><td>{u.activo ? <span className="badge good">Activo</span> : <span className="badge">Inactivo</span>}</td>
            <td>{u.id !== ctx.usuario.id && <button className="btn ghost" onClick={() => accion(async () => { exigir(ctx, 'usuarios'); await db.usuarios.update(u.id, { activo: !u.activo }); })}>{u.activo ? 'Desactivar' : 'Activar'}</button>}</td></tr>
        ))}</tbody>
      </table>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        if (!nuevoNombre.trim()) return;
        const u: Usuario = { id: uuid(), nombre: nuevoNombre.trim(), rol: nuevoRol, sedeId: nuevoRol === 'supervisor' ? null : ctx.sedeId, activo: true };
        const r = await accion(async () => { exigir(ctx, 'usuarios'); await db.usuarios.add(u); return true; }, 'Usuario creado');
        if (r) setNuevoNombre('');
      }}>
        <Campo label="Nombre"><input id="nu-nombre" className="input" value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} /></Campo>
        <Campo label="Rol">
          <select id="nu-rol" className="input" value={nuevoRol} onChange={(e) => setNuevoRol(e.target.value as Rol)}>
            {(Object.keys(ROLES) as Rol[]).map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
          </select>
        </Campo>
        <button className="btn" type="submit">Agregar usuario</button>
      </form>
    </section>
  );
}

function Mantenimiento() {
  const { ctx } = useApp();
  const accion = useAccion();
  const [borrar, setBorrar] = useState(false);
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Mantenimiento</h2>
      <div className="row">
        {MODO_NUBE
          ? <button className="btn" onClick={() => accion(() => rebajarTodo(db, ctx), 'Datos actualizados desde la nube')}>Volver a bajar todo de la nube</button>
          : <button className="btn" onClick={() => accion(() => recalcularStock(db), 'Stock recalculado desde los movimientos')}>Recalcular stock</button>}
        {!MODO_NUBE && (!borrar ? <button className="btn danger" onClick={() => setBorrar(true)}>Borrar datos de la demo</button> : (
          <div className="alert bad row center">
            <span>Se borran ventas, cajas, inventario y precios de este navegador y se recarga el catálogo.</span>
            <button className="btn" onClick={() => setBorrar(false)}>Cancelar</button>
            <button className="btn danger" onClick={async () => { await db.delete(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } location.reload(); }}>Sí, borrar todo</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function TasaDelDia() {
  const { ctx } = useApp();
  const accion = useAccion();
  const tasa = useTasa();
  const [valor, setValor] = useState('');
  const [fuente, setFuente] = useState<'manual' | 'bcv_api'>('manual');
  const n = parseNum(valor);
  return (
    <section className="panel" style={{ maxWidth: 760 }}>
      <h2>Tasa BCV del día</h2>
      <div className="row center">
        {tasa ? <span>Vigente: <strong className="tasa-badge">{num2(tasa.valor)} Bs por $</strong> · cargada el {tasa.fecha} por {tasa.actualizadoPor}</span> : <span className="muted">Todavía no hay tasa: las cajas solo pueden cobrar en $.</span>}
        {tasa && (tasaDeHoy(tasa) ? <span className="badge good">De hoy</span> : <span className="badge warn">Desactualizada</span>)}
      </div>
      <div className="muted small">Cárgala cada mañana antes de abrir. Todas las cajas la reciben al sincronizar; sin internet usan la última que tengan.</div>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        if (n === null) return;
        const r = await accion(() => guardarTasa(db, ctx, n, fuente), 'Tasa guardada');
        if (r) setValor('');
      }}>
        <Campo label="Bs por 1 $ (tasa BCV)"><input id="tasa-valor" className="input" inputMode="decimal" value={valor} onChange={(e) => { setValor(e.target.value); setFuente('manual'); }} placeholder={tasa ? num2(tasa.valor) : 'ej. 210,37'} /></Campo>
        <button type="button" className="btn" onClick={() => accion(async () => { const v = await consultarTasaBcv(); setValor(String(v).replace('.', ',')); setFuente('bcv_api'); }, 'Tasa BCV consultada: revísala y guarda')}>Consultar BCV</button>
        <button type="submit" className="btn primary" disabled={n === null || n <= 0}>Guardar tasa</button>
      </form>
    </section>
  );
}
