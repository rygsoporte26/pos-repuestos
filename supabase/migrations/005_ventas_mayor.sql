-- 005 · Ventas al mayor y pedidos de clientes mayoristas (v1.3.0)
-- Ejecutar una sola vez, después de 001 a 004.
--
-- · ventas.canal: 'tienda' (caja del punto de venta, siempre detal) o 'mayor' (admin o supervisor).
-- · pedidos_mayor: pedidos de clientes mayoristas. Mientras están pendientes apartan piezas;
--   al despacharlos se cobran completos y se vuelven una venta al mayor con el mismo número.
-- · registrar_venta v4: valida el canal y quién puede vender al mayor.
-- · ultimo_mayor: para que el consecutivo al mayor continúe al reinstalar un equipo.

alter table public.ventas add column if not exists canal text not null default 'tienda';
alter table public.ventas drop constraint if exists ventas_canal_check;
alter table public.ventas add constraint ventas_canal_check check (canal in ('tienda','mayor'));
alter table public.ventas add column if not exists pedido_id uuid;
create index if not exists ventas_canal_idx on public.ventas(sede_id, canal, creada_en desc);

create table if not exists public.pedidos_mayor (
  id                  uuid primary key,              -- generado en el PC
  numero              text not null,                 -- ej. 'S1-MC1-000001'
  sede_id             uuid not null references public.sedes(id),
  cliente_nombre      text not null check (trim(cliente_nombre) <> ''),
  cliente_telefono    text,
  nota                text,
  items               jsonb not null,                -- [{productoId, codigo, descripcion, cantidad, precio}]
  total               numeric(12,2) not null check (total >= 0),
  estado              text not null default 'pendiente' check (estado in ('pendiente','despachado','cancelado')),
  venta_id            uuid,                          -- la venta al mayor que lo despachó
  motivo_cancelacion  text,
  creado_en           timestamptz not null,
  creado_por          uuid references auth.users(id) default auth.uid(),
  creado_por_nombre   text,
  actualizado_en      timestamptz not null default now(),
  unique (sede_id, numero)
);
create index if not exists pedidos_mayor_actualizado_idx on public.pedidos_mayor(actualizado_en);

drop trigger if exists pedidos_mayor_actualizado on public.pedidos_mayor;
create trigger pedidos_mayor_actualizado before insert or update on public.pedidos_mayor
for each row execute function public.tg_actualizado();

alter table public.pedidos_mayor enable row level security;
-- Todos los de la sede lo ven (la tienda necesita saber qué está apartado);
-- solo administrador y supervisor crean o cambian pedidos.
drop policy if exists lee_pedidos on public.pedidos_mayor;
create policy lee_pedidos on public.pedidos_mayor for select using (public.puede_sede(sede_id));
drop policy if exists crea_pedidos on public.pedidos_mayor;
create policy crea_pedidos on public.pedidos_mayor for insert
  with check (public.mi_rol() in ('admin','supervisor') and public.puede_sede(sede_id));
drop policy if exists edita_pedidos on public.pedidos_mayor;
create policy edita_pedidos on public.pedidos_mayor for update
  using (public.mi_rol() in ('admin','supervisor') and public.puede_sede(sede_id))
  with check (public.mi_rol() in ('admin','supervisor') and public.puede_sede(sede_id));
grant select, insert, update on public.pedidos_mayor to authenticated;

-- ---------- registrar_venta v4 ----------
create or replace function public.registrar_venta(payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (payload->>'id')::uuid;
  v_sede    uuid := (payload->>'sede_id')::uuid;
  v_canal   text := coalesce(nullif(payload->>'canal',''), 'tienda');
  v_cliente uuid;
  v_total   numeric(12,2) := 0;
  v_costo   numeric(12,2) := 0;
  v_pagado  numeric(12,2) := 0;
  v_linea   numeric(12,2);
  v_usuario uuid;
  it        jsonb;
  pg        jsonb;
  prod      public.productos%rowtype;
  mp        public.medios_pago%rowtype;
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
  if v_canal not in ('tienda','mayor') then
    raise exception 'Canal no válido: %', v_canal;
  end if;
  if v_canal = 'mayor' and public.mi_rol() not in ('admin','supervisor') then
    raise exception 'Solo el administrador o el supervisor venden al mayor';
  end if;
  if v_canal = 'mayor' and nullif(trim(payload->>'cliente_nombre'),'') is null then
    raise exception 'La venta al mayor necesita el nombre del cliente';
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
    usuario_id, cliente_id, cliente_nombre, cliente_telefono, total, costo_total, creada_en, tasa, total_bs,
    canal, pedido_id)
  values (v_id, payload->>'numero', v_sede,
    nullif(payload->>'dispositivo_id','')::uuid, nullif(payload->>'sesion_caja_id','')::uuid,
    v_usuario, v_cliente, nullif(trim(payload->>'cliente_nombre'),''),
    nullif(trim(payload->>'cliente_telefono'),''), 0, 0, (payload->>'creada_en')::timestamptz,
    nullif(payload->>'tasa','')::numeric, nullif(payload->>'total_bs','')::numeric,
    v_canal, nullif(payload->>'pedido_id','')::uuid);

  for it in select * from jsonb_array_elements(payload->'items') loop
    select * into prod from public.productos where id = (it->>'producto_id')::uuid;
    if not found then raise exception 'Producto inexistente: %', it->>'producto_id'; end if;
    v_linea := round((it->>'cantidad')::int * (it->>'precio_unitario')::numeric, 2);
    insert into public.venta_items (id, venta_id, producto_id, descripcion, cantidad,
      tipo_precio, precio_unitario, costo_unitario, total)
    values ((it->>'id')::uuid, v_id, prod.id, prod.descripcion, (it->>'cantidad')::int,
      case when v_canal = 'mayor' then 'mayor' else it->>'tipo_precio' end,
      (it->>'precio_unitario')::numeric, prod.costo, v_linea);
    v_total := v_total + v_linea;
    v_costo := v_costo + round((it->>'cantidad')::int * prod.costo, 2);
    insert into public.movimientos_inventario (id, sede_id, producto_id, tipo, cantidad,
      costo_unitario, referencia_id, usuario_id, creado_en)
    values ((it->>'id')::uuid, v_sede, prod.id, 'venta', -(it->>'cantidad')::int, prod.costo, v_id,
      v_usuario, (payload->>'creada_en')::timestamptz);
  end loop;

  for pg in select * from jsonb_array_elements(coalesce(payload->'pagos','[]'::jsonb)) loop
    select * into mp from public.medios_pago where codigo = pg->>'medio';
    if not found then raise exception 'Método de pago desconocido: %', pg->>'medio'; end if;
    if coalesce(pg->>'tipo','pago') = 'pago' and mp.requiere_referencia
       and coalesce(trim(pg->>'referencia'),'') = '' then
      raise exception 'Falta la referencia de %', mp.nombre;
    end if;
    if mp.moneda = 'VES' and coalesce((pg->>'tasa')::numeric, 0) <= 0 then
      raise exception 'Pago en bolívares sin tasa (%)', mp.nombre;
    end if;
    insert into public.pagos (id, venta_id, medio, tipo, moneda, monto, monto_moneda, tasa, referencia)
    values ((pg->>'id')::uuid, v_id, mp.codigo, coalesce(pg->>'tipo','pago'), mp.moneda,
      (pg->>'monto')::numeric, coalesce((pg->>'monto_moneda')::numeric, (pg->>'monto')::numeric),
      nullif(pg->>'tasa','')::numeric, nullif(trim(pg->>'referencia'),''));
    v_pagado := v_pagado + (pg->>'monto')::numeric;
  end loop;

  if v_pagado <> v_total then
    raise exception 'Pagos (%) no cuadran con el total (%)', v_pagado, v_total;
  end if;
  update public.ventas set total = v_total, costo_total = v_costo where id = v_id;
  return v_id;
end $$;

-- ---------- Último número al mayor de un equipo (ventas y pedidos) ----------
create or replace function public.ultimo_mayor(p_sede uuid, p_prefijo text) returns text
language sql stable security definer set search_path = public as $$
  select max(numero) from (
    select numero from public.ventas where sede_id = p_sede and numero like p_prefijo || '%'
    union all
    select numero from public.pedidos_mayor where sede_id = p_sede and numero like p_prefijo || '%'
  ) t
  where public.puede_sede(p_sede)
$$;

revoke execute on function public.registrar_venta(jsonb) from public, anon;
revoke execute on function public.ultimo_mayor(uuid, text) from public, anon;
grant execute on function public.registrar_venta(jsonb) to authenticated;
grant execute on function public.ultimo_mayor(uuid, text) to authenticated;

update public.config set valor = '"005"' where clave = 'version_esquema';

-- Que la API vea las columnas y la tabla nuevas de inmediato.
notify pgrst, 'reload schema';
