-- Borra productos, inventario, ventas y cajas para empezar de cero.
-- NO es una migración: se ejecuta a mano en el SQL Editor, solo ANTES de arrancar a vender
-- (por ejemplo, para quitar el catálogo GP o las pruebas).
-- Se conservan: usuarios y perfiles, sedes, datos del negocio, tasa del día y su historial.
--
-- Después de ejecutarlo, en CADA PC: Ajustes → Mantenimiento → "Reiniciar este equipo".

truncate public.pagos, public.venta_items, public.ventas, public.movimientos_inventario,
  public.sesiones_caja, public.dispositivos, public.historial_precios, public.producto_modelo,
  public.productos, public.clientes
  restart identity cascade;

-- Comprobar (todo debe dar 0):
select (select count(*) from public.productos) as productos,
       (select count(*) from public.movimientos_inventario) as movimientos,
       (select count(*) from public.ventas) as ventas;
