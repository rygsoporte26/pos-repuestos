-- 004 · Catálogo propio con varios proveedores (v1.2.0)
-- Ejecutar una sola vez, después de 001, 002 y 003.
--
-- · productos.proveedor y productos.ref_proveedor: a quién se le compra y su referencia.
-- · movimientos_inventario.proveedor: proveedor de cada entrada de mercancía.
-- · mover_inventario_lote guarda el proveedor.

alter table public.productos add column if not exists proveedor text;
alter table public.productos add column if not exists ref_proveedor text;
alter table public.movimientos_inventario add column if not exists proveedor text;

comment on column public.productos.codigo is 'Código propio de la tienda (ej. RYG0001)';
comment on column public.productos.proveedor is 'Proveedor al que se le compra (último usado en una entrada)';
comment on column public.productos.ref_proveedor is 'Código o referencia del producto en el proveedor';

create index if not exists productos_proveedor_idx on public.productos(proveedor);

create or replace function public.mover_inventario_lote(p_movs jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare m jsonb; n int := 0;
begin
  if public.mi_rol() not in ('admin','supervisor') then
    raise exception 'Solo el administrador mueve inventario';
  end if;
  for m in select * from jsonb_array_elements(p_movs) loop
    if not public.puede_sede((m->>'sede_id')::uuid) then raise exception 'Sin permiso para la sede'; end if;
    if m->>'tipo' not in ('inicial','compra','ajuste') then raise exception 'Tipo no permitido: %', m->>'tipo'; end if;
    if (m->>'cantidad')::int = 0 then continue; end if;
    insert into public.movimientos_inventario (id, sede_id, producto_id, tipo, cantidad,
      costo_unitario, nota, proveedor, usuario_id, creado_en)
    values ((m->>'id')::uuid, (m->>'sede_id')::uuid, (m->>'producto_id')::uuid, m->>'tipo',
      (m->>'cantidad')::int, nullif(m->>'costo_unitario','')::numeric, nullif(m->>'nota',''), nullif(m->>'proveedor',''),
      public.usuario_operacion(m->>'usuario_id', (m->>'sede_id')::uuid), coalesce((m->>'creado_en')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke execute on function public.mover_inventario_lote(jsonb) from public, anon;
grant execute on function public.mover_inventario_lote(jsonb) to authenticated;

update public.config set valor = '"004"' where clave = 'version_esquema';

-- Que la API vea las columnas nuevas de inmediato.
notify pgrst, 'reload schema';
