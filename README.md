# POS Repuestos

Punto de venta para la tienda de repuestos: venta al detal y al mayor, inventario por sede,
caja con arqueo y panel para el supervisor. Funciona sin internet en la tienda.

## Estado

**Versión 1.3.0:** ventas al mayor separadas de la tienda (pedidos que apartan piezas, despacho cobrado, solo admin y supervisor),
catálogo propio de la tienda con varios proveedores y códigos RYG0001…, plantilla Excel
para cargar catálogo y stock inicial de una vez, métodos de pago (efectivo Bs y $, punto de venta, Biopago,
pago móvil, Binance), pago mixto, vuelto y tasa BCV del día. Login con Supabase, venta sin internet
con sincronización automática, usuarios, respaldo.
La guía de puesta en marcha paso a paso está en el documento "POS Repuestos — Guía de implementación".

## Instalación en la nube (resumen)

1. Supabase → SQL Editor: ejecutar en orden `001_esquema.sql`, `002_sincronizacion.sql`, `003_metodos_pago.sql`, `004_proveedores.sql` y `005_ventas_mayor.sql` (carpeta `supabase/migrations/`).
2. Crear el usuario del supervisor en Authentication y ejecutar `supabase/primer_usuario.sql` con su correo.
3. Cloudflare Pages conectado a este repositorio: build `npm run build`, salida `dist`,
   variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y `NODE_VERSION=22`.
4. Entrar como supervisor, activar usuarios; el administrador carga la tasa BCV y sube la plantilla del catálogo en Ajustes → Catálogo en Excel.

Para borrar productos, inventario y ventas de prueba antes de arrancar: `supabase/borrar_datos_de_prueba.sql` y luego, en cada PC, Ajustes → Mantenimiento → Reiniciar este equipo.

## Cómo correrlo en tu PC

```bash
npm install
npm run dev        # abre http://localhost:5173
npm test           # pruebas de precios, ventas, caja, inventario, pagos e importación Excel
npm run build      # app instalable para Cloudflare Pages (carpeta dist)
npm run build:demo # un solo HTML autocontenido (carpeta dist-demo)
```

Sin variables de entorno la app arranca en **modo demo**. Para producción, copiar
`.env.example` a `.env.local` y llenar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`
(en Cloudflare Pages van en Settings → Environment variables).

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `src/domain/` | Reglas del negocio sin pantallas: precios, ventas de tienda (`ventas.ts`), ventas y pedidos al mayor (`mayor.ts`), pagos y tasa (`pagos.ts`, `tasa.ts`), caja, inventario, productos. Con pruebas `*.test.ts`. |
| `src/db/` | Base local (Dexie/IndexedDB), tipos y carga inicial del catálogo. |
| `src/sync/` | Login (`nube.ts`), cola de cambios (`outbox.ts`), sincronización (`motor.ts`), conversión de datos (`mapeo.ts`). |
| `src/ui/` | Pantallas (`pages/`) y componentes. |
| `src/data/demo.ts` | Productos de ejemplo, solo para el modo demo. |
| `datos/` | Plantilla Excel del catálogo inicial. Se regenera con `python3 scripts/plantilla.py` (sus títulos deben coincidir con `COLUMNAS_PLANTILLA` en `src/domain/importar.ts`). |
| `supabase/migrations/` | Esquema de la base en la nube. Cada cambio = un archivo nuevo numerado; nunca editar uno ya aplicado. |

## Reglas para cambios

1. Cada cambio en una rama (`fix/...`, `mejora/...`), nunca directo en `main`.
2. Lógica de negocio en `src/domain/` con su prueba; las pantallas solo llaman a esas funciones.
3. Toda escritura de datos oficiales deja su registro en el outbox dentro de la misma transacción.
4. Subir la versión en `package.json` y anotar el cambio en `CHANGELOG.md`.
5. Si cambia la base local, agregar `this.version(N+1)` en `src/db/db.ts` (no modificar la versión anterior).
