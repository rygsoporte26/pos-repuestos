-- 006 · Cajas (equipos) de cada sede (v1.3.3)
-- Ejecutar una sola vez, después de 001 a 005.
--
-- Permite al administrador y al supervisor quitar un equipo viejo (un PC reiniciado o de
-- pruebas) para liberar su código de caja. Un equipo con ventas o cajas no se puede quitar
-- (la base lo impide para no perder el historial).

drop policy if exists borra_dispositivos on public.dispositivos;
create policy borra_dispositivos on public.dispositivos for delete
  using (public.puede_sede(sede_id) and public.mi_rol() in ('admin','supervisor'));
grant delete on public.dispositivos to authenticated;

update public.config set valor = '"006"' where clave = 'version_esquema';
notify pgrst, 'reload schema';
