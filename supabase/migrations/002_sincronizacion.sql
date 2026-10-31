-- =====================================================================
-- POS Repuestos — Migración 002: sincronización con las cajas
-- Ejecutar DESPUÉS de 001, una sola vez (SQL Editor → Run).
-- Cambios:
--   * Los PCs envían los ids de los movimientos → reenviar nunca duplica.
--   * Nombres de usuario guardados en ventas, cajas y movimientos (reportes).
--   * Marcas de tiempo "actualizado_en" para bajar solo lo que cambió.
--   * Envío de movimientos por lotes (carga inicial de 1.200 productos).
--   * Cada usuario creado en Authentication recibe un perfil pendiente de
--     activar (vendedor, inactivo) que el administrador activa desde la app.
-- =====================================================================

-- ---------- Columnas nuevas ----------
-- Precio detal vacío = producto sin precio (todavía no se puede vender).
alter table public.productos alter column precio_detal drop not null;
alter table public.productos alter column precio_detal drop default;
alter table public.productos add column if not exists familia text;
alter table public.ventas add column if not exists usuario_nombre text;
alter table public.ventas add column if not exists anulada_por_nombre text;
alter table public.ventas add column if not exists actualizado_en timestamptz not null default now();
alter table public.sesiones_caja add column if not exists usuario_nombre text;
alter table public.sesiones_caja add column if not exists actualizado_en timestamptz not null default now();
alter table public.movimientos_inventario add column if not exists usuario_nombre text;
alter table public.perfiles add column if not exists email text;

create index if not exists ventas_actualizado_idx on public.ventas(actualizado_en);
create index if not exists sesiones_actualizado_idx on public.sesiones_caja(actualizado_en);
create index if not exists mov_recibido_idx on public.movimientos_inventario(recibido_en);
create index if not exists productos_actualizado_idx on public.productos(actualizado_en);

-- Un PC reinstalado obtiene un id nuevo y puede reutilizar su código (C1).
alter table public.dispositivos drop constraint if exists dispositivos_sede_id_codigo_key;

-- ---------- Triggers de apoyo ----------
create or replace function public.tg_usuario_nombre() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.usuario_nombre is null and new.usuario_id is not null then
    select nombre into new.usuario_nombre from public.perfiles where id = new.usuario_id;
  end if;
  return new;
end $$;

create or replace function public.tg_actualizado() returns trigger
language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end $$;

drop trigger if exists ventas_nombre on public.ventas;
create trigger ventas_nombre before insert on public.ventas
for each row execute function public.tg_usuario_nombre();
drop trigger if exists sesiones_nombre on public.sesiones_caja;
create trigger sesiones_nombre before insert on public.sesiones_caja
for each row execute function public.tg_usuario_nombre();
drop trigger if exists movs_nombre on public.movimientos_inventario;
create trigger movs_nombre before insert on public.movimientos_inventario
for each row execute function public.tg_usuario_nombre();

drop trigger if exists ventas_actualizado on public.ventas;
create trigger ventas_actualizado before update on public.ventas
for each row execute function public.tg_actualizado();
drop trigger if exists sesiones_actualizado on public.sesiones_caja;
create trigger sesiones_actualizado before update on public.sesiones_caja
for each row execute function public.tg_actualizado();

-- Perfil automático para cada usuario nuevo de Authentication (inactivo).
create or replace function public.tg_nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (id, nombre, rol, activo, email)
  values (new.id, split_part(coalesce(new.email, 'usuario'), '@', 1), 'vendedor', false, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists nuevo_usuario_perfil on auth.users;
create trigger nuevo_usuario_perfil after insert on auth.users
for each row execute function public.tg_nuevo_usuario();

-- Perfiles para usuarios creados antes de esta migración.
insert into public.perfiles (id, nombre, rol, activo, email)
select u.id, split_part(coalesce(u.email, 'usuario'), '@', 1), 'vendedor', false, u.email
from auth.users u
on conflict (id) do nothing;


-- ---------- Usuario que hizo la operación ----------
-- Un PC puede subir ventas hechas sin internet por un vendedor que ya cerró sesión.
-- Se acepta el usuario indicado si está activo y pertenece a la sede; si no, el actual.
create or replace function public.usuario_operacion(p_usuario text, p_sede uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.perfiles
      where id::text = p_usuario and activo and (sede_id is null or sede_id = p_sede)),
    auth.uid())
$$;

drop policy if exists abre_sesion on public.sesiones_caja;
create policy abre_sesion on public.sesiones_caja for insert
  with check (public.puede_sede(sede_id) and public.usuario_operacion(usuario_id::text, sede_id) = usuario_id);
drop policy if exists cierra_sesion on public.sesiones_caja;
create policy cierra_sesion on public.sesiones_caja for update
  using (public.puede_sede(sede_id)) with check (public.puede_sede(sede_id));

-- ---------- registrar_venta v2: el id de cada línea es el id de su movimiento ----------
create or replace function public.registrar_venta(payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (payload->>'id')::uuid;
  v_sede    uuid := (payload->>'sede_id')::uuid;
  v_cliente uuid;
  v_total   numeric(12,2) := 0;
  v_costo   numeric(12,2) := 0;
  v_pagado  numeric(12,2) := 0;
  v_linea   numeric(12,2);
  v_usuario uuid;
  it        jsonb;
  pg        jsonb;
  prod      public.productos%rowtype;
begin
  if auth.uid() is null or public.mi_rol() is null then
    raise exception 'Usuario no autorizado';
  end if;
  if not public.puede_sede(v_sede) then
    raise exception 'Sin permiso para la sede';
  end if;
  if exists (select 1 from public.ventas where id = v_id) then
    return v_id;                                 -- ya sincronizada
  end if;
  if jsonb_array_length(coalesce(payload->'items','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  v_usuario := public.usuario_operacion(payload->>'usuario_id', v_sede);

  if nullif(trim(payload->>'cliente_nombre'),'') is not null then
    if nullif(trim(payload->>'cliente_telefono'),'') is not null then
      select id into v_cliente from public.clientes where telefono = trim(payload->>'cliente_telefono');
    end if;
    if v_cliente is null then
      insert into public.clientes (nombre, telefono)
      values (trim(payload->>'cliente_nombre'), nullif(trim(payload->>'cliente_telefono'),''))
      returning id into v_cliente;
    end if;
  end if;

  insert into public.ventas (id, numero, sede_id, dispositivo_id, sesion_caja_id,
    usuario_id, cliente_id, cliente_nombre, cliente_telefono, total, costo_total, creada_en)
  values (v_id, payload->>'numero', v_sede,
    nullif(payload->>'dispositivo_id','')::uuid, nullif(payload->>'sesion_caja_id','')::uuid,
    v_usuario, v_cliente, nullif(trim(payload->>'cliente_nombre'),''),
    nullif(trim(payload->>'cliente_telefono'),''), 0, 0, (payload->>'creada_en')::timestamptz);

  for it in select * from jsonb_array_elements(payload->'items') loop
    select * into prod from public.productos where id = (it->>'producto_id')::uuid;
    if not found then raise exception 'Producto inexistente: %', it->>'producto_id'; end if;
    v_linea := round((it->>'cantidad')::int * (it->>'precio_unitario')::numeric, 2);
    insert into public.venta_items (id, venta_id, producto_id, descripcion, cantidad,
      tipo_precio, precio_unitario, costo_unitario, total)
    values ((it->>'id')::uuid, v_id, prod.id, prod.descripcion, (it->>'cantidad')::int,
      it->>'tipo_precio', (it->>'precio_unitario')::numeric, prod.costo, v_linea);
    v_total := v_total + v_linea;
    v_costo := v_costo + round((it->>'cantidad')::int * prod.costo, 2);
    insert into public.movimientos_inventario (id, sede_id, producto_id, tipo, cantidad,
      costo_unitario, referencia_id, usuario_id, creado_en)
    values ((it->>'id')::uuid, v_sede, prod.id, 'venta', -(it->>'cantidad')::int, prod.costo, v_id,
      v_usuario, (payload->>'creada_en')::timestamptz);
  end loop;

  for pg in select * from jsonb_array_elements(coalesce(payload->'pagos','[]'::jsonb)) loop
    insert into public.pagos (id, venta_id, medio, monto, recibido, cambio)
    values ((pg->>'id')::uuid, v_id, pg->>'medio', (pg->>'monto')::numeric,
      nullif(pg->>'recibido','')::numeric, nullif(pg->>'cambio','')::numeric);
    v_pagado := v_pagado + (pg->>'monto')::numeric;
  end loop;

  if v_pagado <> v_total then
    raise exception 'Pagos (%) no cuadran con el total (%)', v_pagado, v_total;
  end if;
  update public.ventas set total = v_total, costo_total = v_costo where id = v_id;
  return v_id;
end $$;

-- ---------- anular_venta v2: recibe los ids de movimiento {item_id: mov_id} ----------
drop function if exists public.anular_venta(uuid, text);
create or replace function public.anular_venta(p_venta uuid, p_motivo text, p_movs jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.ventas%rowtype;
begin
  if public.mi_rol() not in ('admin','supervisor') then
    raise exception 'Solo el administrador puede anular ventas';
  end if;
  if coalesce(trim(p_motivo),'') = '' then raise exception 'El motivo es obligatorio'; end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if not public.puede_sede(v.sede_id) then raise exception 'Sin permiso para la sede'; end if;
  if v.estado = 'anulada' then return; end if;

  update public.ventas
     set estado = 'anulada', anulada_en = now(), anulada_por = auth.uid(),
         anulada_por_nombre = (select nombre from public.perfiles where id = auth.uid()),
         motivo_anulacion = trim(p_motivo)
   where id = p_venta;

  insert into public.movimientos_inventario (id, sede_id, producto_id, tipo, cantidad,
    costo_unitario, referencia_id, nota, usuario_id)
  select coalesce(nullif(p_movs->>(i.id::text), '')::uuid, gen_random_uuid()),
         v.sede_id, i.producto_id, 'anulacion', i.cantidad, i.costo_unitario, v.id, trim(p_motivo), auth.uid()
    from public.venta_items i where i.venta_id = v.id
  on conflict (id) do nothing;
end $$;

-- ---------- Movimientos por lote (inicial, compra, ajuste), idempotente ----------
drop function if exists public.mover_inventario(uuid, uuid, text, int, text, numeric);
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
      costo_unitario, nota, usuario_id, creado_en)
    values ((m->>'id')::uuid, (m->>'sede_id')::uuid, (m->>'producto_id')::uuid, m->>'tipo',
      (m->>'cantidad')::int, nullif(m->>'costo_unitario','')::numeric, nullif(m->>'nota',''),
      public.usuario_operacion(m->>'usuario_id', (m->>'sede_id')::uuid), coalesce((m->>'creado_en')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------- Último número de ticket de una caja (al reinstalar un PC) ----------
create or replace function public.ultimo_ticket(p_sede uuid, p_prefijo text) returns text
language sql stable security definer set search_path = public as $$
  select max(numero) from public.ventas
  where sede_id = p_sede and numero like p_prefijo || '%' and public.puede_sede(p_sede)
$$;

revoke execute on function public.anular_venta(uuid, text, jsonb) from public, anon;
revoke execute on function public.mover_inventario_lote(jsonb) from public, anon;
revoke execute on function public.ultimo_ticket(uuid, text) from public, anon;
revoke execute on function public.usuario_operacion(text, uuid) from public, anon;
grant execute on function public.anular_venta(uuid, text, jsonb) to authenticated;
grant execute on function public.mover_inventario_lote(jsonb) to authenticated;
grant execute on function public.ultimo_ticket(uuid, text) to authenticated;
grant execute on function public.usuario_operacion(text, uuid) to authenticated;

update public.config set valor = '"002"' where clave = 'version_esquema';
