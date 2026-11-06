# Cambios

## 1.4.0 — 2026-11-04

Descuento por pago en divisa y método USDT.

- Al cobrar, si **todos** los pagos son en divisa (efectivo $, Binance o USDT), el vendedor puede escribir un descuento en % o en $. Con pago mixto en bolívares no aparece.
- Tope: el % máximo lo fija el administrador en Ajustes → Datos del negocio (10% por defecto; 0 = sin descuento). La nube rechaza descuentos mayores o con pagos en bolívares.
- Si hay un solo pago y no se tocó su monto, se ajusta solo al total con descuento.
- El ticket muestra subtotal, descuento y total; la venta guarda el descuento; el Panel suma los descuentos del día; el respaldo CSV trae descuento y total de la venta.
- Funciona igual en la caja de la tienda y en las ventas al mayor.
- Nuevo método de pago **USDT** (en $, referencia obligatoria), aparte de Binance.
- Migración 007: columna de descuento, método USDT y registrar_venta v5.

## 1.3.3 — 2026-10-31

Códigos de caja estables.

- El código de caja se asigna solo la primera vez que el equipo se conecta (el primero libre) y después **nunca cambia solo**. Si se repite con otro equipo en uso, se muestra un aviso en Caja y en Ajustes.
- Corrección: al entrar, la pantalla podía volver a escribir el código viejo encima del nuevo (por eso aparecían C6 y similares, o volvía a C1).
- Un equipo nuevo se registra apenas entra y no deja abrir caja hasta tener su código.
- Cambio manual en Ajustes → Este equipo: necesita internet, no deja usar un código que otro equipo está usando y continúa la numeración de tickets de ese código.
- Nueva sección Ajustes → Cajas de esta sede: lista de equipos con su código y último uso, y botón Quitar para liberar el código de un equipo viejo.
- "Reiniciar este equipo" libera su código en la nube.
- Migración 006: permiso para quitar equipos (administrador y supervisor).

## 1.3.2 — 2026-10-31

Sincronización más rápida.

- Las descargas de la nube se piden todas a la vez en lugar de una tras otra: con internet lento (250 ms por consulta) cada sincronización pasó de unos 7 s a cerca de 1 s.
- El stock oficial (la consulta más pesada) se baja solo cuando hubo movimientos de inventario o cada 10 minutos; el registro del equipo se revisa al entrar y cada 2 minutos.
- Se sincroniza cada 15 s (antes 30 s), al volver a la ventana del POS y menos de 1 s después de cada venta o cambio. Una venta de otro PC aparece en unos 15 s como máximo.

## 1.3.1 — 2026-10-31

- Corrección: dos PCs de la misma sede podían quedar con el mismo código de caja (por ejemplo, los dos S1-C1) si entraban al mismo tiempo o después de limpiar la base. Ahora en cada sincronización se revisa y se cambia solo el equipo que todavía no ha vendido (si ninguno vendió, el más nuevo). Si los dos ya vendieron con el mismo código, se muestra un aviso en Caja y en Ajustes.

## 1.3.0 — 2026-10-31

Ventas al mayor separadas de la tienda.

- La tienda (caja del vendedor) vende siempre a precio detal. El precio mayor se ve como referencia, pero las ventas al mayor solo las hacen el administrador y el supervisor.
- Nueva sección **Mayor** (admin y supervisor): pedido del cliente mayorista con cliente obligatorio, productos, cantidades y precio por pieza (sale del precio mayor y se puede cambiar).
- **Apartar**: el pedido pendiente reserva las piezas. La tienda ve "Disponible = stock − apartado"; Productos y Entrada de mercancía muestran lo apartado y para quién.
- **Despachar y cobrar**: se cobra completo (mismos métodos de pago, mixto y vuelto) y sale del inventario como venta al mayor con el mismo número del pedido. También se puede vender al mayor directo sin apartar.
- Pendientes con estado "Listo" o "Faltan N pzs" (el stock se reparte por orden de llegada), modificar y cancelar con motivo.
- Las ventas al mayor no entran en la caja ni en el arqueo del vendedor. Numeración propia: S1-MC1-000001 (admin en la caja C1), S1-MSV-000001 (supervisor).
- Ventas: columna y filtro por canal. Panel: tienda vs. mayor y pedidos pendientes. Ticket con "VENTA AL MAYOR". Respaldo CSV con canal.
- Migración 005: canal en ventas, tabla pedidos_mayor con permisos (solo admin y supervisor crean o cambian pedidos), registrar_venta v4 (la nube rechaza ventas al mayor de un vendedor), ultimo_mayor.

## 1.2.0 — 2026-10-31

Catálogo propio de la tienda, con varios proveedores.

- Se quita la lista GP Motocycles (1.207 productos) y su botón de carga inicial: el catálogo se arma a mano con los productos que la tienda maneja de todos sus proveedores.
- Códigos propios automáticos: RYG0001, RYG0002… (el prefijo se cambia en Ajustes → Datos del negocio). También se puede escribir el código a mano.
- Proveedor y referencia del proveedor en cada producto; se busca por ellos al vender y en inventario. Filtro por proveedor en Productos.
- Plantilla nueva `datos/Plantilla_catalogo_inicial.xlsx` (una hoja, un producto por fila, con stock contado). La misma plantilla vacía se descarga desde el POS.
- Ajustes → Catálogo en Excel: importa la plantilla (crea productos, actualiza los existentes y registra el stock inicial), con resumen y errores por fila antes de aplicar. Evita duplicar productos si el archivo se sube dos veces.
- Descargar catálogo actual en Excel con el mismo formato, para cambiar precios en bloque y volver a subirlo (STOCK CONTADO sale vacío; el stock de hoy va en una columna que no se importa).
- Entrada de mercancía: proveedor por entrada (queda en el movimiento y como proveedor del producto), botón para crear un producto nuevo ahí mismo, proveedor y nota se mantienen para cargar una factura completa.
- Productos: botón Editar para corregir descripción, categoría, motos, proveedor y referencia. "Familia" pasa a llamarse "Categoría".
- Mantenimiento: "Reiniciar este equipo" borra los datos locales del PC y los vuelve a bajar de la nube (no deja hacerlo si hay cambios sin subir).
- Corrección: después de registrar una entrada de mercancía el formulario no se limpiaba.
- Modo demo con 22 productos de ejemplo inventados.
- Migración 004: proveedor y referencia en productos, proveedor en movimientos. Script `supabase/borrar_datos_de_prueba.sql` para empezar de cero antes de vender.

## 1.1.0 — 2026-10-30

Métodos de pago de la tienda y tasa BCV.

- Seis métodos: efectivo bolívares (Bs), efectivo divisa ($), punto de venta (PV), Biopago (Bio), pago móvil (PM) y Binance (Bin).
- Pago mixto: una venta se puede pagar con varios métodos hasta completar el total.
- Vuelto a elección del vendedor: efectivo $, efectivo Bs o pago móvil, calculado a la tasa del día.
- Referencia obligatoria en punto de venta, Biopago, pago móvil y Binance (también la exige la nube).
- Tasa BCV del día: la carga el administrador en Ajustes (a mano o con "Consultar BCV"), llega a todas las cajas al sincronizar y queda en el historial. Aviso cuando la tasa no es de hoy; sin tasa solo se cobra en $.
- Caja con base y arqueo separados en $ y Bs, y cobrado por método.
- Ticket con total en Bs, tasa, pagos, referencias y vuelto. Panel y ventas con el detalle por método; respaldo CSV con tasa y pagos.
- Migración 003: métodos de pago, columnas de pagos (moneda, monto en su moneda, tasa, referencia, vuelto), caja en Bs, historial de tasas, registrar_venta v3.

## 1.0.0 — 2026-10-19

Versión para producción, conectada a Supabase.

- Login con usuario y contraseña; perfil pendiente hasta que el administrador lo active con rol y sede.
- Sincronización automática: sube ventas, cajas, anulaciones, productos y movimientos en orden y por lotes; baja catálogo, stock, ventas, cajas, usuarios y datos del negocio. Funciona sin internet y reintenta solo.
- Cada PC recibe un código de caja libre (C1, C2…); el consecutivo de tickets continúa al reinstalar.
- Ventas hechas sin internet quedan a nombre de quien las hizo aunque otro usuario las suba.
- Ajustes: estado de sincronización con opción de descartar un cambio rechazado, carga inicial del catálogo GP, importación de la plantilla Excel (precios, conteo, productos nuevos), usuarios en la nube, respaldo CSV.
- Botón Imprimir en el ticket; la app abre sin internet desde el primer ingreso.
- Migración 002: ids de movimiento desde el PC, nombres de usuario, lotes de inventario, perfil automático por usuario nuevo, precio detal opcional.

## 0.1.0 — 2026-10-19

Primera versión funcional (modo demo, sin nube).

- Catálogo GP precargado: 1.207 productos, 96 familias, con costo por pieza y moto que aplica.
- Vender: búsqueda por código, nombre o moto; precio mayor automático desde la cantidad mínima del producto; cobro en efectivo USD con cambio; cliente opcional; ticket en pantalla; atajos Enter y F2.
- Caja: apertura con base y cierre con arqueo (sobrante o faltante).
- Ventas: historial por día; anulación solo por el administrador, con motivo; el stock vuelve.
- Productos: carga de precios detal, mayor, cantidad mínima y stock mínimo por fila, con avisos (mayor ≥ detal, bajo costo); filtro de productos sin precio; alta de productos nuevos.
- Inventario: conteo físico por familia (inicial / ajuste por diferencia), entrada de mercancía por bultos o piezas, historial de movimientos.
- Panel: vendido, utilidad, ticket promedio, anuladas, últimos 7 días, más vendidos, stock bajo, cajas.
- Ajustes: datos del negocio para el ticket, código de caja, usuarios.
- Esquema Supabase 001 con funciones `registrar_venta`, `anular_venta`, `mover_inventario` y permisos por rol y sede.
