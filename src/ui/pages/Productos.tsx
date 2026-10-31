import { useEffect, useMemo, useState } from 'react';
import { db } from '../../db/db';
import type { Producto } from '../../db/types';
import { crearProducto, guardarProducto, siguienteCodigo } from '../../domain/productos';
import { ganancia, revisarPrecios } from '../../domain/precios';
import { normalizar, parseEntero, parseNum } from '../../domain/util';
import { Campo, Modal, useAccion, useApp, useToast } from '../components/ui';
import { claseStock, useProductos, useStock } from '../hooks';

const POR_PAGINA = 50;
type Filtro = 'todos' | 'sin_precio' | 'con_precio' | 'sin_mayor' | 'inactivos';

export function Productos() {
  const { ctx } = useApp();
  const productos = useProductos();
  const stock = useStock(ctx.sedeId);
  const [q, setQ] = useState('');
  const [familia, setFamilia] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [pagina, setPagina] = useState(0);
  const [nuevo, setNuevo] = useState(false);
  const [editar, setEditar] = useState<Producto | null>(null);

  const familias = useMemo(() => [...new Set(productos.map((p) => p.familia).filter(Boolean) as string[])].sort(), [productos]);
  const proveedores = useMemo(() => [...new Set(productos.map((p) => p.proveedor).filter(Boolean) as string[])].sort(), [productos]);
  const conPrecio = productos.filter((p) => p.activo && p.precioDetal !== null).length;
  const activos = productos.filter((p) => p.activo).length;

  const lista = useMemo(() => {
    const palabras = normalizar(q).split(' ').filter(Boolean);
    return productos
      .filter((p) => (filtro === 'inactivos' ? !p.activo : p.activo))
      .filter((p) => filtro !== 'sin_precio' || p.precioDetal === null)
      .filter((p) => filtro !== 'con_precio' || p.precioDetal !== null)
      .filter((p) => filtro !== 'sin_mayor' || (p.precioDetal !== null && p.precioMayor === null))
      .filter((p) => !familia || p.familia === familia)
      .filter((p) => !proveedor || p.proveedor === proveedor)
      .filter((p) => palabras.every((w) => p.busqueda.includes(w)))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
  }, [productos, q, familia, proveedor, filtro]);
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  const pag = Math.min(pagina, paginas - 1);
  const visibles = lista.slice(pag * POR_PAGINA, pag * POR_PAGINA + POR_PAGINA);

  return (
    <>
      <div className="row center">
        <h1>Productos y precios</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setNuevo(true)}>Nuevo producto</button>
      </div>
      <div className="panel">
        <div className="row center">
          <strong>{conPrecio} de {activos} productos con precio</strong>
          <div className="bar-track" style={{ flex: 1, minWidth: 120 }}><div className="bar" style={{ width: `${activos ? (conPrecio / activos) * 100 : 0}%`, background: 'var(--good)' }} /></div>
        </div>
        <div className="muted small">Escribe los precios en USD por pieza y pulsa Enter o “Guardar”. El precio mayor se aplica solo cuando el cliente lleva la cantidad mínima o más. Para corregir descripción, motos o proveedor usa “Editar”.</div>
        {productos.length === 0 && <div className="alert info">Todavía no hay productos. Créalos con “Nuevo producto” o súbelos todos de una vez desde Excel en Ajustes → Catálogo en Excel.</div>}
        <div className="row">
          <Campo label="Buscar"><input id="buscar-prod" className="input" value={q} onChange={(e) => { setQ(e.target.value); setPagina(0); }} placeholder="Código, nombre, moto o proveedor" /></Campo>
          <Campo label="Categoría">
            <select id="familia" className="input" value={familia} onChange={(e) => { setFamilia(e.target.value); setPagina(0); }}>
              <option value="">Todas ({familias.length})</option>
              {familias.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Campo>
          <Campo label="Proveedor">
            <select id="proveedor" className="input" value={proveedor} onChange={(e) => { setProveedor(e.target.value); setPagina(0); }}>
              <option value="">Todos ({proveedores.length})</option>
              {proveedores.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Campo>
          <Campo label="Mostrar">
            <select id="filtro" className="input" value={filtro} onChange={(e) => { setFiltro(e.target.value as Filtro); setPagina(0); }}>
              <option value="sin_precio">Sin precio</option>
              <option value="con_precio">Con precio</option>
              <option value="sin_mayor">Con precio, sin precio mayor</option>
              <option value="todos">Todos</option>
              <option value="inactivos">Desactivados</option>
            </select>
          </Campo>
        </div>
        <div className="pager">
          <span>{lista.length} productos</span>
          <button className="btn" disabled={pag === 0} onClick={() => setPagina(pag - 1)}>Anterior</button>
          <span>Página {pag + 1} de {paginas}</span>
          <button className="btn" disabled={pag >= paginas - 1} onClick={() => setPagina(pag + 1)}>Siguiente</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Código</th><th className="desc">Descripción</th><th className="num">Costo</th><th className="num">Detal</th><th className="num">Ganancia</th>
                <th className="num">Mayor</th><th className="num">Desde (pzs)</th><th className="num">Stock</th><th className="num">Stock mín.</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((p) => <FilaProducto key={p.id} p={p} stock={stock.get(p.id) ?? 0} onEditar={() => setEditar(p)} />)}
            </tbody>
          </table>
        </div>
        {visibles.length === 0 && <div className="muted">No hay productos con este filtro.</div>}
      </div>
      {nuevo && <FormProducto onClose={() => setNuevo(false)} />}
      {editar && <FormProducto producto={editar} onClose={() => setEditar(null)} />}
    </>
  );
}

const s = (n: number | null) => (n === null ? '' : n.toFixed(2).replace('.', ','));
const ent = (n: number | null) => (n === null ? '' : String(n));

function FilaProducto({ p, stock, onEditar }: { p: Producto; stock: number; onEditar: () => void }) {
  const { ctx } = useApp();
  const avisar = useToast();
  const accion = useAccion();
  const original = { costo: s(p.costo), detal: s(p.precioDetal), mayor: s(p.precioMayor), min: ent(p.cantMinMayor), smin: String(p.stockMinimo) };
  const [f, setF] = useState(original);
  // Sucio = algún valor numérico distinto al guardado ("5" y "5,00" son iguales).
  const igual = (txt: string, v: number | null) => (txt.trim() === '' ? v === null : parseNum(txt) === v);
  const dirty = !igual(f.costo, p.costo) || !igual(f.detal, p.precioDetal) || !igual(f.mayor, p.precioMayor)
    || !igual(f.min, p.cantMinMayor) || !igual(f.smin, p.stockMinimo);

  const valores = {
    costo: parseNum(f.costo) ?? p.costo, precioDetal: parseNum(f.detal), precioMayor: parseNum(f.mayor),
    cantMinMayor: f.min.trim() === '' ? null : parseEntero(f.min) ?? -1,
  };
  const problemas = dirty ? revisarPrecios(valores) : [];
  const bloquea = problemas.find((x) => x.bloquea);
  const g = ganancia(valores.precioDetal, valores.costo);

  async function guardar() {
    if (!dirty) return;
    const smin = parseEntero(f.smin);
    const avisos = await accion(() => guardarProducto(db, ctx, p.id, { ...valores, stockMinimo: smin ?? -1 }));
    if (avisos !== undefined) setF({ costo: s(valores.costo), detal: s(valores.precioDetal), mayor: s(valores.precioMayor), min: ent(valores.cantMinMayor), smin: String(smin) });
    if (avisos !== undefined) avisar(avisos.length ? `Guardado. Ojo: ${avisos.join('; ')}` : `Guardado ${p.codigo}`, avisos.length > 0);
  }
  const campo = (k: keyof typeof f, label: string, invalid = false, qty = false) => (
    <input
      className={`input cell${qty ? ' qty' : ''}${invalid ? ' invalid' : ''}`} aria-label={`${label} ${p.codigo}`} inputMode="decimal"
      value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && guardar()}
    />
  );
  return (
    <tr className={dirty ? 'dirty' : ''}>
      <td className="mono">{p.codigo}</td>
      <td className="desc">
        <div>{p.descripcion}</div>
        <div className="muted small">{p.marcaAplica ?? '—'} · {p.familia ?? 'sin categoría'}{p.proveedor ? ` · ${p.proveedor}${p.refProveedor ? ` (${p.refProveedor})` : ''}` : ''}</div>
        {bloquea && <div className="small" style={{ color: 'var(--bad)' }}>{bloquea.mensaje}</div>}
        {!bloquea && problemas.length > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{problemas.map((x) => x.mensaje).join(' · ')}</div>}
      </td>
      <td className="num">{campo('costo', 'Costo')}</td>
      <td className="num">{campo('detal', 'Precio detal', problemas.some((x) => x.campo === 'precioDetal' && x.bloquea))}</td>
      <td className="num muted">{g === null ? '—' : `${Math.round(g * 100)}%`}</td>
      <td className="num">{campo('mayor', 'Precio mayor', problemas.some((x) => x.campo === 'precioMayor' && x.bloquea))}</td>
      <td className="num">{campo('min', 'Cantidad mínima mayor', problemas.some((x) => x.campo === 'cantMinMayor' && x.bloquea), true)}</td>
      <td className={`num ${claseStock(stock, p.stockMinimo)}`}>{stock}</td>
      <td className="num">{campo('smin', 'Stock mínimo', parseEntero(f.smin) === null, true)}</td>
      <td>
        {dirty && (
          <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <button className="btn primary" disabled={!!bloquea} onClick={guardar}>Guardar</button>
            <button className="btn ghost" onClick={() => setF(original)}>Deshacer</button>
          </div>
        )}
        {!dirty && (
          <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <button className="btn ghost small" onClick={onEditar}>Editar</button>
            <button className="btn ghost small" onClick={() => accion(() => guardarProducto(db, ctx, p.id, { activo: !p.activo }), p.activo ? 'Producto desactivado' : 'Producto activado')}>
              {p.activo ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** Crear un producto nuevo, o editar los datos de texto de uno existente. */
export function FormProducto({ producto, onClose, onCreado }: { producto?: Producto; onClose: () => void; onCreado?: (p: Producto) => void }) {
  const { ctx } = useApp();
  const accion = useAccion();
  const productos = useProductos();
  const familias = useMemo(() => [...new Set(productos.map((p) => p.familia).filter(Boolean) as string[])].sort(), [productos]);
  const proveedores = useMemo(() => [...new Set(productos.map((p) => p.proveedor).filter(Boolean) as string[])].sort(), [productos]);
  const [f, setF] = useState(() => producto
    ? { codigo: producto.codigo, descripcion: producto.descripcion, familia: producto.familia ?? '', moto: producto.marcaAplica ?? '', proveedor: producto.proveedor ?? '', ref: producto.refProveedor ?? '', costo: '', detal: '', mayor: '', min: '', smin: '' }
    : { codigo: '', descripcion: '', familia: '', moto: '', proveedor: '', ref: '', costo: '', detal: '', mayor: '', min: '', smin: '' });
  const [sugerido, setSugerido] = useState('');
  useEffect(() => { if (!producto) siguienteCodigo(db).then((c) => { setSugerido(c); setF((x) => (x.codigo ? x : { ...x, codigo: c })); }); }, [producto]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={producto ? `Editar ${producto.codigo}` : 'Nuevo producto'} onClose={onClose}>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={async (e) => {
        e.preventDefault();
        if (producto) {
          const r = await accion(() => guardarProducto(db, ctx, producto.id, {
            descripcion: f.descripcion, familia: f.familia, marcaAplica: f.moto, proveedor: f.proveedor, refProveedor: f.ref,
          }), 'Producto guardado');
          if (r !== undefined) onClose();
          return;
        }
        const r = await accion(() => crearProducto(db, ctx, {
          codigo: f.codigo, descripcion: f.descripcion, familia: f.familia || null, marcaAplica: f.moto || null,
          proveedor: f.proveedor || null, refProveedor: f.ref || null,
          costo: parseNum(f.costo) ?? 0, precioDetal: parseNum(f.detal), precioMayor: parseNum(f.mayor),
          cantMinMayor: f.min.trim() ? parseEntero(f.min) : null, stockMinimo: f.smin.trim() ? parseEntero(f.smin) ?? -1 : 0,
        }), 'Producto creado');
        if (r) { onCreado?.(r); onClose(); }
      }}>
        <div className="row">
          <Campo label={producto ? 'Código' : `Código${sugerido ? ` (siguiente libre: ${sugerido})` : ''}`}>
            <input id="np-codigo" className="input mono" value={f.codigo} onChange={set('codigo')} disabled={!!producto} />
          </Campo>
          <Campo label="Categoría">
            <input id="np-familia" className="input" list="familias" value={f.familia} onChange={set('familia')} placeholder="Ej. FRENOS" />
            <datalist id="familias">{familias.map((x) => <option key={x} value={x} />)}</datalist>
          </Campo>
        </div>
        <Campo label="Descripción"><input id="np-desc" className="input" value={f.descripcion} onChange={set('descripcion')} autoFocus /></Campo>
        <Campo label="Motos compatibles"><input id="np-moto" className="input" value={f.moto} onChange={set('moto')} placeholder="Ej. BERA SBR, EMPIRE HORSE 150, JAGUAR" /></Campo>
        <div className="row">
          <Campo label="Proveedor">
            <input id="np-proveedor" className="input" list="proveedores" value={f.proveedor} onChange={set('proveedor')} />
            <datalist id="proveedores">{proveedores.map((x) => <option key={x} value={x} />)}</datalist>
          </Campo>
          <Campo label="Ref. del proveedor"><input id="np-ref" className="input" value={f.ref} onChange={set('ref')} /></Campo>
        </div>
        {!producto && (
          <div className="row">
            <Campo label="Costo USD"><input id="np-costo" className="input" inputMode="decimal" value={f.costo} onChange={set('costo')} /></Campo>
            <Campo label="Precio detal"><input id="np-detal" className="input" inputMode="decimal" value={f.detal} onChange={set('detal')} /></Campo>
            <Campo label="Precio mayor"><input id="np-mayor" className="input" inputMode="decimal" value={f.mayor} onChange={set('mayor')} /></Campo>
            <Campo label="Mayor desde (pzs)"><input id="np-min" className="input" inputMode="numeric" value={f.min} onChange={set('min')} /></Campo>
            <Campo label="Stock mínimo"><input id="np-smin" className="input" inputMode="numeric" value={f.smin} onChange={set('smin')} /></Campo>
          </div>
        )}
        {!producto && <div className="muted small">El stock se carga después en Inventario: “Entrada de mercancía” si acaba de llegar, o “Conteo físico” si ya estaba en la tienda.</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" type="submit">{producto ? 'Guardar' : 'Crear producto'}</button></div>
      </form>
    </Modal>
  );
}
