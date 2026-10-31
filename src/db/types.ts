// Tipos de datos locales. Reflejan las tablas de supabase/migrations/001_esquema.sql
// (en camelCase). Si se cambia una tabla, cambiar aquí y en la migración.

export type Rol = 'vendedor' | 'admin' | 'supervisor';

export interface Usuario {
  id: string;
  nombre: string;
  rol: Rol;
  sedeId: string | null; // null = todas las sedes
  activo: boolean;
  email?: string;
}

export interface Sede {
  id: string;
  codigo: string; // 'S1'
  nombre: string;
}

export interface Producto {
  id: string;
  codigo: string;
  descripcion: string;
  familia: string | null;
  marcaAplica: string | null; // moto(s) compatibles, texto
  presentacion: string | null; // '1X100'
  unidadesBulto: number | null;
  unidadCompra: string | null; // BULTO, PIEZA…
  costo: number; // USD por pieza
  precioDetal: number | null; // null = sin precio, no se puede vender
  precioMayor: number | null;
  cantMinMayor: number | null;
  stockMinimo: number;
  activo: boolean;
  actualizadoEn: string;
  busqueda: string; // texto normalizado para buscar
}

export type TipoMovimiento =
  | 'inicial' | 'compra' | 'venta' | 'anulacion' | 'ajuste'
  | 'traslado_salida' | 'traslado_entrada' | 'devolucion';

export interface Movimiento {
  id: string;
  sedeId: string;
  productoId: string;
  tipo: TipoMovimiento;
  cantidad: number; // + entra, - sale
  costoUnitario: number | null;
  referenciaId: string | null;
  nota: string | null;
  usuarioId: string;
  usuarioNombre: string;
  creadoEn: string;
}

export interface Stock {
  key: string; // `${sedeId}|${productoId}`
  sedeId: string;
  productoId: string;
  stock: number;
}

export type TipoPrecio = 'detal' | 'mayor';

export interface VentaItem {
  id: string;
  productoId: string;
  codigo: string;
  descripcion: string;
  cantidad: number;
  tipoPrecio: TipoPrecio;
  precioUnitario: number;
  costoUnitario: number;
  total: number;
}

export type MedioPago = 'efectivo_usd' | 'efectivo_bs' | 'punto_venta' | 'biopago' | 'pago_movil' | 'binance';
export type Moneda = 'USD' | 'VES';

/**
 * Un pago (o un vuelto, con monto negativo). El total de la venta siempre es la suma
 * de "monto" en USD; "montoMoneda" es lo que se movió en su moneda (Bs o $).
 */
export interface Pago {
  id: string;
  medio: MedioPago;
  tipo: 'pago' | 'vuelto';
  moneda: Moneda;
  montoMoneda: number; // en la moneda del medio (negativo si es vuelto)
  tasa: number | null; // Bs por USD usada (solo pagos en Bs)
  monto: number; // equivalente en USD aplicado a la venta (negativo si es vuelto)
  referencia: string | null;
  /** Solo ventas de la versión 1.0 (antes de los métodos de pago). */
  recibido?: number;
  cambio?: number;
}

export interface Venta {
  id: string;
  numero: string; // S1-C1-000001
  sedeId: string;
  dispositivoId: string;
  sesionCajaId: string;
  usuarioId: string;
  usuarioNombre: string;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  items: VentaItem[];
  pagos: Pago[];
  total: number;
  tasa: number | null; // tasa BCV usada en la venta
  totalBs: number | null;
  costoTotal: number;
  estado: 'completada' | 'anulada';
  creadaEn: string;
  dia: string; // YYYY-MM-DD local, para filtrar
  anuladaEn: string | null;
  anuladaPor: string | null;
  motivoAnulacion: string | null;
}

export interface SesionCaja {
  id: string;
  sedeId: string;
  dispositivoId: string;
  usuarioId: string;
  usuarioNombre: string;
  abiertaEn: string;
  efectivoInicial: number; // USD
  efectivoInicialBs: number;
  cerradaEn: string | null;
  efectivoContado: number | null;
  efectivoEsperado: number | null;
  diferencia: number | null;
  efectivoContadoBs: number | null;
  efectivoEsperadoBs: number | null;
  diferenciaBs: number | null;
  resumen: Partial<Record<MedioPago, { moneda: Moneda; montoMoneda: number; monto: number; cantidad: number }>> | null;
  notas: string | null;
}

export type TipoOutbox = 'venta' | 'anulacion' | 'movimiento' | 'producto' | 'sesion_caja' | 'config';

export interface OutboxItem {
  seq?: number;
  tipo: TipoOutbox;
  refId: string;
  payload: unknown;
  formato: number; // versión del formato de payload
  creadoEn: string;
  intentos: number;
  error: string | null;
}

export interface Meta {
  clave: string;
  valor: unknown;
}

export interface Negocio {
  nombre: string;
  direccion: string;
  telefono: string;
  mensajeTicket: string;
}

export interface Tasa {
  valor: number; // Bs por 1 USD
  fecha: string; // YYYY-MM-DD (día local en que se cargó)
  fuente: 'manual' | 'bcv_api';
  actualizadoEn: string;
  actualizadoPor: string;
}
