-- =====================================================================
-- POS Repuestos — Migración 001: esquema inicial
-- Ejecutar UNA vez en Supabase → SQL Editor → Run.
-- Diseño:
--   * Multi-sede desde el día 1 (sede_id en todo lo operativo).
--   * Inventario como kardex: el stock = suma de movimientos. Nunca se
--     sobreescribe un número, así varias cajas sin internet no se pisan.
--   * IDs (uuid) generados en el PC de venta: reenviar una venta es
--     idempotente (no se duplica).
--   * Las ventas no se borran: se anulan con motivo y movimiento inverso.
--   * Escrituras de venta y anulación solo por funciones (RPC) que
--     validan rol y sede.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Catálogos base
-- ---------------------------------------------------------------------
create table public.sedes (
  id          uuid primary key default gen_random_uuid(),
  codigo      text not null unique,             -- ej. 'S1' (prefijo de tickets)
  nombre      text not null,
  direccion   text,
  telefono    text,
  activa      boolean not null default true,
  creado_en   timestamptz not null default now()
);

create table public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null,
  rol         text not null check (rol in ('vendedor','admin','supervisor')),
  sede_id     uuid references public.sedes(id),  -- null = todas las sedes
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

create table public.dispositivos (
  id            uuid primary key,                -- generado en el PC
  sede_id       uuid not null references public.sedes(id),
  codigo        text not null,                   -- ej. 'C1' (caja 1)
  nombre        text,
  ultimo_sync   timestamptz,
  version_app   text,
  creado_en     timestamptz not null default now(),
  unique (sede_id, codigo)
);

create table public.familias (
  id      serial primary key,
  nombre  text not null unique
);

create table public.productos (
  id                 uuid primary key default gen_random_uuid(),
  codigo             text not null unique,        -- código del importador
  descripcion        text not null,
  familia_id         int references public.familias(id),
  marca_aplica       text,                        -- texto original del importador
  presentacion       text,                        -- ej. '1X100'
  unidades_bulto     int check (unidades_bulto is null or unidades_bulto > 0),
  unidad_compra      text,                        -- BULTO, PIEZA, PAQUETE…
  costo              numeric(12,2) not null default 0 check (costo >= 0),
  precio_detal       numeric(12,2) not null default 0 check (precio_detal >= 0),
  precio_mayor       numeric(12,2) check (precio_mayor is null or precio_mayor >= 0),
  cant_min_mayor     int check (cant_min_mayor is null or cant_min_mayor > 0),
  stock_minimo       int not null default 0,      -- alerta de stock bajo
  activo             boolean not null default true,
  actualizado_en     timestamptz not null default now(),
  actualizado_por    uuid references auth.users(id),
  constraint mayor_completo check (
    (precio_mayor is null and cant_min_mayor is null) or
    (precio_mayor is not null and cant_min_mayor is not null))
);
create index productos_familia_idx on public.productos(familia_id);

-- Compatibilidad producto ↔ modelo de moto (búsqueda "para Jaguar 200")
create table public.modelos_moto (
  id      serial primary key,
  nombre  text not null unique                    -- ej. 'JAGUAR 200', 'HORSE'
);
create table public.producto_modelo (
  producto_id  uuid not null references public.productos(id) on delete cascade,
  modelo_id    int  not null references public.modelos_moto(id) on delete cascade,
  primary key (producto_id, modelo_id)
);

-- Historial automático de cambios de precio/costo
create table public.historial_precios (
  id              bigserial primary key,
  producto_id     uuid not null references public.productos(id) on delete cascade,
  costo           numeric(12,2),
  precio_detal    numeric(12,2),
  precio_mayor    numeric(12,2),
  cant_min_mayor  int,
  cambiado_en     timestamptz not null default now(),
  cambiado_por    uuid
);

create table public.clientes (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  telefono   text,
  creado_en  timestamptz not null default now()
);
create unique index clientes_telefono_uq on public.clientes(telefono) where telefono is not null;

create table public.medios_pago (
  codigo  text primary key,                       -- 'efectivo_usd'
  nombre  text not null,
  activo  boolean not null default true
);

-- ---------------------------------------------------------------------
-- Caja
-- ---------------------------------------------------------------------
create table public.sesiones_caja (
  id                 uuid primary key,             -- generado en el PC
  sede_id            uuid not null references public.sedes(id),
  dispositivo_id     uuid references public.dispositivos(id),
  usuario_id         uuid not null references auth.users(id),
  abierta_en         timestamptz not null,
  efectivo_inicial   numeric(12,2) not null default 0,
  cerrada_en         timestamptz,
  efectivo_contado   numeric(12,2),                -- arqueo
  efectivo_esperado  numeric(12,2),                -- inicial + ventas efectivo
  diferencia         numeric(12,2),                -- contado - esperado
  notas              text,
  recibido_en        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Ventas
-- ---------------------------------------------------------------------
create table public.ventas (
  id                uuid primary key,              -- generado en el PC
  numero            text not null,                 -- ej. 'S1-C1-000123'
  sede_id           uuid not null references public.sedes(id),
  dispositivo_id    uuid references public.dispositivos(id),
  sesion_caja_id    uuid references public.sesiones_caja(id),
  usuario_id        uuid not null references auth.users(id),
  cliente_id        uuid references public.clientes(id),
  cliente_nombre    text,
  cliente_telefono  text,
  total             numeric(12,2) not null check (total >= 0),
  costo_total       numeric(12,2) not null default 0,
  estado            text not null default 'completada'
                      check (estado in ('completada','anulada')),
  creada_en         timestamptz not null,          -- hora del PC
  recibida_en       timestamptz not null default now(),  -- hora de llegada a la nube
  anulada_en        timestamptz,
  anulada_por       uuid references auth.users(id),
  motivo_anulacion  text,
  unique (sede_id, numero)
);
create index ventas_sede_fecha_idx on public.ventas(sede_id, creada_en desc);

create table public.venta_items (
  id               uuid primary key,
  venta_id         uuid not null references public.ventas(id) on delete cascade,
  producto_id      uuid not null references public.productos(id),
  descripcion      text not null,                  -- copia al momento de vender
  cantidad         int  not null check (cantidad > 0),
  tipo_precio      text not null check (tipo_precio in ('detal','mayor')),
  precio_unitario  numeric(12,2) not null check (precio_unitario >= 0),
  costo_unitario   numeric(12,2) not null default 0,
  total            numeric(12,2) not null
);
create index venta_items_venta_idx on public.venta_items(venta_id);

create table public.pagos (
  id         uuid primary key,
  venta_id   uuid not null references public.ventas(id) on delete cascade,
  medio      text not null references public.medios_pago(codigo),
  monto      numeric(12,2) not null check (monto >= 0),  -- aplicado a la venta
  recibido   numeric(12,2),                               -- lo que entregó el cliente
  cambio     numeric(12,2)
);

-- ---------------------------------------------------------------------
-- Inventario (kardex)
-- ---------------------------------------------------------------------
create table public.movimientos_inventario (
  id              uuid primary key default gen_random_uuid(),
  sede_id         uuid not null references public.sedes(id),
  producto_id     uuid not null references public.productos(id),
  tipo            text not null check (tipo in
                    ('inicial','compra','venta','anulacion','ajuste',
                     'traslado_salida','traslado_entrada','devolucion')),
  cantidad        int  not null check (cantidad <> 0),   -- + entra, - sale
  costo_unitario  numeric(12,2),
  referencia_id   uuid,                                  -- venta, compra, traslado…
  nota            text,
  usuario_id      uuid references auth.users(id),
  creado_en       timestamptz not null default now(),
  recibido_en     timestamptz not null default now()
);
create index mov_sede_prod_idx on public.movimientos_inventario(sede_id, producto_id);
create index mov_ref_idx on public.movimientos_inventario(referencia_id);

create view public.stock_actual
with (security_invoker = true) as
select m.sede_id, m.producto_id, sum(m.cantidad)::int as stock
from public.movimientos_inventario m
group by m.sede_id, m.producto_id;

-- ---------------------------------------------------------------------
-- Soporte: errores de la app y configuración
-- ---------------------------------------------------------------------
create table public.errores_app (
  id             bigserial primary key,
  usuario_id     uuid default auth.uid(),
  dispositivo_id uuid,
  version_app    text,
  mensaje        text not null,
  detalle        text,
  creado_en      timestamptz not null default now()
);

create table public.config (
  clave  text primary key,
  valor  jsonb not null
);

-- =====================================================================
-- Funciones auxiliares de permisos
-- =====================================================================
create or replace function public.mi_rol() returns text
language sql stable security definer set search_path = public as $$
  select rol from public.perfiles where id = auth.uid() and activo
$$;

create or replace function public.mi_sede() returns uuid
language sql stable security definer set search_path = public as $$
  select sede_id from public.perfiles where id = auth.uid() and activo
$$;

-- ¿El usuario actual puede ver/operar en esta sede?
create or replace function public.puede_sede(p_sede uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and activo
      and (rol = 'supervisor' or sede_id is null or sede_id = p_sede))
$$;

-- =====================================================================
-- Trigger: historial de precios
-- =====================================================================
create or replace function public.tg_productos_sello() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.actualizado_en := now();
  new.actualizado_por := auth.uid();
  return new;
end $$;

create or replace function public.tg_historial_precios() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT'
     or new.costo is distinct from old.costo
     or new.precio_detal is distinct from old.precio_detal
     or new.precio_mayor is distinct from old.precio_mayor
     or new.cant_min_mayor is distinct from old.cant_min_mayor then
    insert into public.historial_precios
      (producto_id, costo, precio_detal, precio_mayor, cant_min_mayor, cambiado_por)
    values (new.id, new.costo, new.precio_detal, new.precio_mayor, new.cant_min_mayor, auth.uid());
  end if;
  return null;
end $$;

create trigger productos_sello
before insert or update on public.productos
for each row execute function public.tg_productos_sello();

create trigger productos_historial
after insert or update on public.productos
for each row execute function public.tg_historial_precios();

-- =====================================================================
-- RPC: registrar una venta (idempotente)
-- payload = {
--   id, numero, sede_id, dispositivo_id, sesion_caja_id, creada_en,
--   cliente_nombre?, cliente_telefono?,
--   items: [{id, producto_id, cantidad, tipo_precio, precio_unitario}],
--   pagos: [{id, medio, monto, recibido?, cambio?}]
-- }
-- Devuelve el id de la venta. Si ya existía, no hace nada (reintento seguro).
-- =====================================================================
create or replace function public.registrar_venta(payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (payload->>'id')::uuid;
  v_sede    uuid := (payload->>'sede_id')::uuid;
  v_cliente uuid;
  v_total   numeric(12,2) := 0;
  v_costo   numeric(12,2) := 0;
  v_pagado  numeric(12,2) := 0;
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

  -- Cliente opcional: se reutiliza por teléfono
  if nullif(trim(payload->>'cliente_nombre'),'') is not null then
    if nullif(trim(payload->>'cliente_telefono'),'') is not null then
      select id into v_cliente from public.clientes
       where telefono = trim(payload->>'cliente_telefono');
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
    nullif(payload->>'dispositivo_id','')::uuid,
    nullif(payload->>'sesion_caja_id','')::uuid,
    auth.uid(), v_cliente,
    nullif(trim(payload->>'cliente_nombre'),''),
    nullif(trim(payload->>'cliente_telefono'),''),
    0, 0, (payload->>'creada_en')::timestamptz);

  for it in select * from jsonb_array_elements(payload->'items') loop
    select * into prod from public.productos where id = (it->>'producto_id')::uuid;
    if not found then
      raise exception 'Producto inexistente: %', it->>'producto_id';
    end if;
    insert into public.venta_items (id, venta_id, producto_id, descripcion, cantidad,
      tipo_precio, precio_unitario, costo_unitario, total)
    values ((it->>'id')::uuid, v_id, prod.id, prod.descripcion,
      (it->>'cantidad')::int, it->>'tipo_precio',
      (it->>'precio_unitario')::numeric, prod.costo,
      round((it->>'cantidad')::int * (it->>'precio_unitario')::numeric, 2));
    -- El precio lo fija el PC (puede haber vendido sin internet con el precio
    -- que tenía en ese momento); queda registrado para auditoría.
    v_total := v_total + round((it->>'cantidad')::int * (it->>'precio_unitario')::numeric, 2);
    v_costo := v_costo + round((it->>'cantidad')::int * prod.costo, 2);

    insert into public.movimientos_inventario (sede_id, producto_id, tipo, cantidad,
      costo_unitario, referencia_id, usuario_id, creado_en)
    values (v_sede, prod.id, 'venta', -(it->>'cantidad')::int, prod.costo, v_id,
      auth.uid(), (payload->>'creada_en')::timestamptz);
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

-- =====================================================================
-- RPC: anular venta (solo admin o supervisor, motivo obligatorio)
-- =====================================================================
create or replace function public.anular_venta(p_venta uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.ventas%rowtype;
begin
  if public.mi_rol() not in ('admin','supervisor') then
    raise exception 'Solo el administrador puede anular ventas';
  end if;
  if coalesce(trim(p_motivo),'') = '' then
    raise exception 'El motivo es obligatorio';
  end if;
  select * into v from public.ventas where id = p_venta for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if not public.puede_sede(v.sede_id) then raise exception 'Sin permiso para la sede'; end if;
  if v.estado = 'anulada' then return; end if;

  update public.ventas
     set estado = 'anulada', anulada_en = now(), anulada_por = auth.uid(),
         motivo_anulacion = trim(p_motivo)
   where id = p_venta;

  insert into public.movimientos_inventario (sede_id, producto_id, tipo, cantidad,
    costo_unitario, referencia_id, nota, usuario_id)
  select v.sede_id, i.producto_id, 'anulacion', i.cantidad, i.costo_unitario, v.id,
         trim(p_motivo), auth.uid()
    from public.venta_items i where i.venta_id = v.id;
end $$;

-- =====================================================================
-- RPC: ajuste / entrada de inventario (admin o supervisor)
-- tipo: 'inicial' | 'compra' | 'ajuste'
-- =====================================================================
create or replace function public.mover_inventario(
  p_sede uuid, p_producto uuid, p_tipo text, p_cantidad int, p_nota text default null,
  p_costo numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if public.mi_rol() not in ('admin','supervisor') then
    raise exception 'Solo el administrador mueve inventario';
  end if;
  if not public.puede_sede(p_sede) then raise exception 'Sin permiso para la sede'; end if;
  if p_tipo not in ('inicial','compra','ajuste') then raise exception 'Tipo no permitido'; end if;
  if p_tipo = 'ajuste' and coalesce(trim(p_nota),'') = '' then
    raise exception 'El ajuste requiere nota';
  end if;
  insert into public.movimientos_inventario (sede_id, producto_id, tipo, cantidad,
    costo_unitario, nota, usuario_id)
  values (p_sede, p_producto, p_tipo, p_cantidad, p_costo, p_nota, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- =====================================================================
-- Seguridad a nivel de fila (RLS)
-- =====================================================================
alter table public.sedes                  enable row level security;
alter table public.perfiles               enable row level security;
alter table public.dispositivos           enable row level security;
alter table public.familias               enable row level security;
alter table public.productos              enable row level security;
alter table public.modelos_moto           enable row level security;
alter table public.producto_modelo        enable row level security;
alter table public.historial_precios      enable row level security;
alter table public.clientes               enable row level security;
alter table public.medios_pago            enable row level security;
alter table public.sesiones_caja          enable row level security;
alter table public.ventas                 enable row level security;
alter table public.venta_items            enable row level security;
alter table public.pagos                  enable row level security;
alter table public.movimientos_inventario enable row level security;
alter table public.errores_app            enable row level security;
alter table public.config                 enable row level security;

-- Lectura de catálogos: cualquier usuario activo
create policy lee_sedes     on public.sedes            for select using (public.mi_rol() is not null);
create policy lee_familias  on public.familias         for select using (public.mi_rol() is not null);
create policy lee_productos on public.productos        for select using (public.mi_rol() is not null);
create policy lee_modelos   on public.modelos_moto     for select using (public.mi_rol() is not null);
create policy lee_prodmod   on public.producto_modelo  for select using (public.mi_rol() is not null);
create policy lee_medios    on public.medios_pago      for select using (public.mi_rol() is not null);
create policy lee_config    on public.config           for select using (public.mi_rol() is not null);
create policy lee_clientes  on public.clientes         for select using (public.mi_rol() is not null);

-- Edición de catálogos: admin y supervisor
create policy edita_productos on public.productos for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));
create policy edita_familias on public.familias for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));
create policy edita_modelos on public.modelos_moto for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));
create policy edita_prodmod on public.producto_modelo for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));
create policy edita_sedes on public.sedes for all
  using (public.mi_rol() = 'supervisor') with check (public.mi_rol() = 'supervisor');
create policy edita_config on public.config for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));

-- Perfiles: cada uno ve el suyo; admin/supervisor ven todos
create policy lee_perfiles on public.perfiles for select
  using (id = auth.uid() or public.mi_rol() in ('admin','supervisor'));
create policy edita_perfiles on public.perfiles for all
  using (public.mi_rol() in ('admin','supervisor'))
  with check (public.mi_rol() in ('admin','supervisor'));

-- Historial de precios: admin y supervisor
create policy lee_historial on public.historial_precios for select
  using (public.mi_rol() in ('admin','supervisor'));

-- Operación por sede
create policy lee_dispositivos on public.dispositivos for select using (public.puede_sede(sede_id));
create policy reg_dispositivos on public.dispositivos for insert with check (public.puede_sede(sede_id));
create policy act_dispositivos on public.dispositivos for update
  using (public.puede_sede(sede_id)) with check (public.puede_sede(sede_id));

create policy lee_sesiones on public.sesiones_caja for select using (public.puede_sede(sede_id));
create policy abre_sesion  on public.sesiones_caja for insert
  with check (public.puede_sede(sede_id) and usuario_id = auth.uid());
create policy cierra_sesion on public.sesiones_caja for update
  using (public.puede_sede(sede_id) and (usuario_id = auth.uid() or public.mi_rol() in ('admin','supervisor')))
  with check (public.puede_sede(sede_id));

create policy lee_ventas on public.ventas for select using (public.puede_sede(sede_id));
create policy lee_items  on public.venta_items for select
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.puede_sede(v.sede_id)));
create policy lee_pagos  on public.pagos for select
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.puede_sede(v.sede_id)));
create policy lee_movs   on public.movimientos_inventario for select using (public.puede_sede(sede_id));
-- (ventas, items, pagos y movimientos se escriben solo por las funciones RPC)

create policy reporta_error on public.errores_app for insert with check (auth.uid() is not null);
create policy lee_errores   on public.errores_app for select using (public.mi_rol() in ('admin','supervisor'));

revoke execute on function public.registrar_venta(jsonb) from public, anon;
revoke execute on function public.anular_venta(uuid, text) from public, anon;
revoke execute on function public.mover_inventario(uuid, uuid, text, int, text, numeric) from public, anon;
grant execute on function public.registrar_venta(jsonb) to authenticated;
grant execute on function public.anular_venta(uuid, text) to authenticated;
grant execute on function public.mover_inventario(uuid, uuid, text, int, text, numeric) to authenticated;

-- =====================================================================
-- Datos iniciales
-- =====================================================================
insert into public.medios_pago (codigo, nombre) values ('efectivo_usd', 'Efectivo USD');
insert into public.sedes (codigo, nombre) values ('S1', 'Tienda principal');
insert into public.config (clave, valor) values
  ('version_esquema', '"001"'),
  ('moneda', '"USD"');
