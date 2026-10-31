-- =====================================================================
-- POS Repuestos — Migración 003: métodos de pago y tasa BCV
-- Ejecutar DESPUÉS de 002, una sola vez (SQL Editor → Run).
-- Métodos: efectivo Bs, efectivo $, punto de venta, Biopago, pago móvil, Binance.
-- Una venta puede pagarse con varios métodos; lo que sobra se registra como
-- vuelto (pago negativo) por el método que elija el vendedor. Los pagos en Bs
-- guardan la tasa BCV usada y su referencia (obligatoria salvo en efectivo).
-- =====================================================================

-- ---------- Métodos de pago ----------
alter table public.medios_pago add column if not exists moneda text not null default 'USD';
alter table public.medios_pago add column if not exists requiere_referencia boolean not null default false;
alter table public.medios_pago add column if not exists efectivo boolean not null default false;
alter table public.medios_pago drop constraint if exists medios_pago_moneda_check;
alter table public.medios_pago add constraint medios_pago_moneda_check check (moneda in ('USD','VES'));

insert into public.medios_pago (codigo, nombre, moneda, requiere_referencia, efectivo) values
  ('efectivo_bs',  'Efectivo bolívares', 'VES', false, true),
  ('efectivo_usd', 'Efectivo divisa',    'USD', false, true),
  ('punto_venta',  'Punto de venta',     'VES', true,  false),
  ('biopago',      'Biopago',            'VES', true,  false),
  ('pago_movil',   'Pago móvil',         'VES', true,  false),
  ('binance',      'Binance',            'USD', true,  false)
on conflict (codigo) do update set nombre = excluded.nombre, moneda = excluded.moneda,
  requiere_referencia = excluded.requiere_referencia, efectivo = excluded.efectivo, activo = true;

-- ---------- Pagos: moneda, monto en su moneda, tasa, referencia y vuelto ----------
alter table public.pagos drop constraint if exists pagos_monto_check;
alter table public.pagos add column if not exists tipo text not null default 'pago';
alter table public.pagos add column if not exists moneda text not null default 'USD';
alter table public.pagos add column if not exists monto_moneda numeric(14,2);
alter table public.pagos add column if not exists tasa numeric(14,4);
alter table public.pagos add column if not exists referencia text;
update public.pagos set monto_moneda = monto where monto_moneda is null;
alter table public.pagos drop constraint if exists pagos_tipo_check;
alter table public.pagos add constraint pagos_tipo_check check (tipo in ('pago','vuelto'));
alter table public.pagos drop constraint if exists pagos_moneda_check;
alter table public.pagos add constraint pagos_moneda_check check (moneda in ('USD','VES'));
alter table public.pagos drop constraint if exists pagos_signo_check;
alter table public.pagos add constraint pagos_signo_check
  check ((tipo = 'pago' and monto >= 0) or (tipo = 'vuelto' and monto <= 0));

-- ---------- Ventas y cajas en bolívares ----------
alter table public.ventas add column if not exists tasa numeric(14,4);
alter table public.ventas add column if not exists total_bs numeric(14,2);
alter table public.sesiones_caja add column if not exists efectivo_inicial_bs numeric(14,2) not null default 0;
alter table public.sesiones_caja add column if not exists efectivo_contado_bs numeric(14,2);
alter table public.sesiones_caja add column if not exists efectivo_esperado_bs numeric(14,2);
alter table public.sesiones_caja add column if not exists diferencia_bs numeric(14,2);
alter table public.sesiones_caja add column if not exists resumen jsonb; -- cobrado por método al cierre

-- ---------- Historial de la tasa BCV ----------
create table if not exists public.tasas_historial (
  id          bigserial primary key,
  fecha       date not null,
  valor       numeric(14,4) not null check (valor > 0),
  fuente      text,
  cargada_por text,
  creado_en   timestamptz not null default now()
);
alter table public.tasas_historial enable row level security;
drop policy if exists lee_tasas on public.tasas_historial;
create policy lee_tasas on public.tasas_historial for select using (public.mi_rol() is not null);

-- Cada vez que el administrador guarda la tasa (config 'tasa'), queda en el historial.
create or replace function public.tg_tasa_historial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.clave = 'tasa' and (tg_op = 'INSERT' or new.valor is distinct from old.valor) then
    insert into public.tasas_historial (fecha, valor, fuente, cargada_por)
    values (coalesce((new.valor->>'fecha')::date, current_date), (new.valor->>'valor')::numeric,
            new.valor->>'fuente', new.valor->>'actualizadoPor');
  end if;
  return new;
end $$;
drop trigger if exists config_tasa_historial on public.config;
create trigger config_tasa_historial after insert or update on public.config
for each row execute function public.tg_tasa_historial();

-- ---------- registrar_venta v3: varios pagos, vuelto, tasa y referencia ----------
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
    usuario_id, cliente_id, cliente_nombre, cliente_telefono, total, costo_total, creada_en, tasa, total_bs)
  values (v_id, payload->>'numero', v_sede,
    nullif(payload->>'dispositivo_id','')::uuid, nullif(payload->>'sesion_caja_id','')::uuid,
    v_usuario, v_cliente, nullif(trim(payload->>'cliente_nombre'),''),
    nullif(trim(payload->>'cliente_telefono'),''), 0, 0, (payload->>'creada_en')::timestamptz,
    nullif(payload->>'tasa','')::numeric, nullif(payload->>'total_bs','')::numeric);

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

update public.config set valor = '"003"' where clave = 'version_esquema';
