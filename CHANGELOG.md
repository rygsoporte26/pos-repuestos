# Cambios

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
