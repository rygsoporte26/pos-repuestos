-- Activa al primer usuario como SUPERVISOR (dueño). Ejecutar una vez en SQL Editor
-- después de crear el usuario en Authentication → Users → Add user.
-- Cambia el correo por el real.
update public.perfiles
   set rol = 'supervisor', activo = true, sede_id = null, nombre = 'Supervisor'
 where email = 'CORREO_DEL_SUPERVISOR@gmail.com';

-- Comprobación: debe mostrar 1 fila activa.
select nombre, rol, activo, email from public.perfiles where rol = 'supervisor';
