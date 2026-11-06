-- 007 · Descuento por pago en divisa y método USDT (v1.4.0)
-- Ejecutar una sola vez, después de 001 a 006.
--
-- · ventas.descuento: USD descontados (total = suma de productos − descuento).
-- · Nuevo método de pago USDT (en dólares, referencia obligatoria).
-- · registrar_venta v5: el descuento solo se acepta si todos los pagos son en divisa
--   (efectivo $, Binance, USDT) y hasta el % máximo de Ajustes → Datos del negocio.

alter table public.ventas add column if not exists descuento numeric(12,2) not null default 0;
alter table public.ventas drop constraint if exists ventas_descuento_check;
alter table public.ventas add constraint ventas_descuento_check check (descuento >= 0);

insert into public.medios_pago (codigo, nombre, moneda, requiere_referencia, efectivo) values
  ('usdt', 'USDT', 'USD', true, false)
on conflict (codigo) do update set nombre = excluded.nombre, moneda = excluded.moneda,
  requiere_referencia = excluded.requiere_referencia, efectivo = excluded.efectivo;

-- ---------- registrar_venta v5 ----------
create or replace function public.registrar_venta(payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (payload->>'id')::uuid;
  v_sede    uuid := (payload->>'sede_id')::uuid;
  v_canal   text := coalesce(nullif(payload->>'canal',''), 'tienda');
  v_desc    numeric(12,2) := coalesce(nullif(payload->>'descuento','')::numeric, 0);
  v_max     numeric := coalesce((select (valor->>'descuentoMaxDivisa')::numeric from public.config where clave = 'negocio'), 10);
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
  if v_desc < 0 then raise exception 'El descuento no puede ser negativo'; end if;
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
    if v_desc > 0 and coalesce(pg->>'tipo','pago') = 'pago' and mp.moneda <> 'USD' then
      raise exception 'El descuento solo se permite si todo se paga en divisa (efectivo $, Binance o USDT)';
    end if;
    v_pagado := v_pagado + (pg->>'monto')::numeric;
  end loop;

  -- Descuento por pago en divisa: hasta el % máximo de los datos del negocio (con 1 centavo de holgura).
  if v_desc > round(v_total * v_max / 100, 2) + 0.01 then
    raise exception 'Descuento (%) mayor al máximo permitido (% %%)', v_desc, v_max;
  end if;
  if v_pagado <> v_total - v_desc then
    raise exception 'Pagos (%) no cuadran con el total (%)', v_pagado, v_total - v_desc;
  end if;
  update public.ventas set total = v_total - v_desc, descuento = v_desc, costo_total = v_costo where id = v_id;
  return v_id;
end $$;

revoke execute on function public.registrar_venta(jsonb) from public, anon;
grant execute on function public.registrar_venta(jsonb) to authenticated;

update public.config set valor = '"007"' where clave = 'version_esquema';
notify pgrst, 'reload schema';
