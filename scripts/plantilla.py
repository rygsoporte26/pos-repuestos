"""Genera la plantilla Excel del catálogo inicial (datos/Plantilla_catalogo_inicial.xlsx).

Uso:  python3 scripts/plantilla.py                 -> plantilla vacía
      python3 scripts/plantilla.py --ejemplo RUTA  -> plantilla con filas de prueba (para los tests)

Los títulos de las columnas A-L deben coincidir con COLUMNAS_PLANTILLA en src/domain/importar.ts.
Las columnas M-O son ayudas (fórmulas) y el POS las ignora al importar.
"""
import sys
import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill, Side, Border
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule
from openpyxl.utils import get_column_letter

FILAS = 1500
F = 'Arial'
COLS = [  # título, ancho, tipo
    ('CODIGO', 12, 'texto'), ('DESCRIPCION', 42, 'texto'), ('CATEGORIA', 18, 'texto'), ('MOTOS COMPATIBLES', 30, 'texto'),
    ('PROVEEDOR', 18, 'texto'), ('REF. PROVEEDOR', 15, 'texto'), ('COSTO USD (PIEZA)', 11, 'usd'), ('PRECIO DETAL USD', 11, 'usd'),
    ('PRECIO MAYOR USD', 11, 'usd'), ('CANT. MIN. MAYOR', 10, 'entero'), ('STOCK CONTADO (PIEZAS)', 12, 'entero'),
    ('STOCK MINIMO (ALERTA)', 11, 'entero'),
]
AYUDAS = [('% GANANCIA DETAL (auto)', 11), ('VALOR AL COSTO USD (auto)', 12), ('REVISAR (auto)', 22)]

EJEMPLO = [
    ['', 'PASTILLA FRENO DELANTERA DISCO', 'FRENOS', 'BERA SBR, EMPIRE HORSE 150', 'IMPORTADORA A', 'PF-110', 2.1, 5, 4, 10, 40, 8],
    ['RYG0010', 'GUAYA CLUTCH', 'GUAYAS', 'EMPIRE HORSE 150, OWEN 150', 'REPUESTOS DEL CENTRO', 'GC-15', 1.2, 3, None, None, 30, 10],
    ['', 'BUJIA C7HSA', 'ELECTRICO', 'UNIVERSAL', 'IMPORTADORA A', 'C7HSA', 0.9, 2.5, 2, 20, 120, 30],
    ['', 'FILTRO ACEITE', 'MOTOR', 'EMPIRE HORSE 150', 'REPUESTOS DEL CENTRO', None, 0.8, None, None, None, 12, None],
    ['', 'CDI 5 PINES', 'ELECTRICO', 'BERA BR150', 'ELECTRO MOTOS', 'CDI-5P', 3.9, 9, 7.5, None, 9, 3],
    ['', 'RETROVISOR PAR CROMADO', 'ACCESORIOS', 'UNIVERSAL', 'ELECTRO MOTOS', None, 2.8, 7, 6, 6, 'cinco', 4],
    ['RYG0010', 'GUAYA REPETIDA', 'GUAYAS', None, None, None, 1, 2, None, None, 1, None],
    [None] * 12,
    ['', 'TRIPA 275-18', 'CAUCHOS', None, 'CAUCHOS EL LLANO', None, '2,20', '5', None, None, '3', 6],
]


def crear(salida, filas=()):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Catalogo'
    head = PatternFill('solid', fgColor='1F2933')
    ayuda = PatternFill('solid', fgColor='6B7280')
    entrada = PatternFill('solid', fgColor='FFF8E1')
    borde = Border(bottom=Side(style='thin', color='D0D0D0'))
    for c, (t, w, _) in enumerate(COLS, 1):
        x = ws.cell(1, c, t)
        x.font = Font(name=F, bold=True, color='FFFFFF')
        x.fill = head
        x.alignment = Alignment(wrap_text=True, vertical='center', horizontal='center')
        ws.column_dimensions[get_column_letter(c)].width = w
    for j, (t, w) in enumerate(AYUDAS, len(COLS) + 1):
        x = ws.cell(1, j, t)
        x.font = Font(name=F, bold=True, color='FFFFFF')
        x.fill = ayuda
        x.alignment = Alignment(wrap_text=True, vertical='center', horizontal='center')
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.row_dimensions[1].height = 44
    ult = FILAS + 1
    for i in range(2, ult + 1):
        for c, (_, _, tipo) in enumerate(COLS, 1):
            x = ws.cell(i, c)
            x.font = Font(name=F, size=10)
            x.border = borde
            if tipo == 'texto':
                x.number_format = '@'
            elif tipo == 'usd':
                x.number_format = '#,##0.00'
                x.fill = entrada
            else:
                x.number_format = '0'
                x.fill = entrada
        ws.cell(i, 13, f'=IF(OR(H{i}="",G{i}="",G{i}=0),"",H{i}/G{i}-1)').number_format = '0%'
        ws.cell(i, 14, f'=IF(OR(K{i}="",G{i}=""),"",K{i}*G{i})').number_format = '#,##0.00'
        ws.cell(i, 15, (
            f'=IF(B{i}="","",IF(COUNTIF($A$2:$A${ult},A{i})>1,"Código repetido",'
            f'IF(OR(AND(I{i}<>"",J{i}=""),AND(I{i}="",J{i}<>"")),"Mayor: falta precio o cantidad",'
            f'IF(AND(H{i}<>"",G{i}<>"",H{i}<G{i}),"Detal bajo costo",'
            f'IF(AND(I{i}<>"",H{i}<>"",I{i}>=H{i}),"Mayor >= detal",IF(H{i}="","Sin precio detal",""))))))'))
        for c in (13, 14, 15):
            ws.cell(i, c).font = Font(name=F, size=10, color='4B5563')
    for r, fila in enumerate(filas, 2):
        for c, v in enumerate(fila, 1):
            if v not in (None, ''):
                ws.cell(r, c, v)
    ws.freeze_panes = 'C2'
    ws.auto_filter.ref = f'A1:O{ult}'
    dv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', showErrorMessage=True,
                        errorTitle='Valor no válido', error='Escribe un número en dólares, 0 o más (ej. 5,50).')
    dv.add(f'G2:I{ult}')
    ws.add_data_validation(dv)
    dvm = DataValidation(type='whole', operator='greaterThanOrEqual', formula1='2', showErrorMessage=True,
                         errorTitle='Valor no válido', error='Cantidad mínima para precio mayor: entero de 2 o más.')
    dvm.add(f'J2:J{ult}')
    ws.add_data_validation(dvm)
    dvs = DataValidation(type='whole', operator='greaterThanOrEqual', formula1='0', showErrorMessage=True,
                         errorTitle='Valor no válido', error='Piezas: número entero, 0 o más.')
    dvs.add(f'K2:L{ult}')
    ws.add_data_validation(dvs)
    rojo = PatternFill('solid', fgColor='F8D7DA')
    ws.conditional_formatting.add(f'A2:A{ult}', FormulaRule(formula=[f'AND(A2<>"",COUNTIF($A$2:$A${ult},A2)>1)'], fill=rojo))
    ws.conditional_formatting.add(f'O2:O{ult}', FormulaRule(formula=['LEN(O2)>0'], fill=rojo, font=Font(color='9C0006', bold=True)))

    ins = wb.create_sheet('Instrucciones')
    ins.column_dimensions['A'].width = 30
    ins.column_dimensions['B'].width = 95
    texto = [
        ('PLANTILLA DEL CATÁLOGO INICIAL — POS REPUESTOS', None),
        ('Para qué sirve', 'Armar el catálogo completo de la tienda (todos los proveedores) con el stock contado hoy, y subirlo al POS de una sola vez.'),
        ('Cómo llenarla', 'Una fila por producto en la hoja "Catalogo". No cambies los títulos de la fila 1. Las columnas grises se calculan solas.'),
        ('  CODIGO', 'Código propio de la tienda: RYG0001, RYG0002… Si lo dejas vacío, el POS asigna el siguiente libre al importar. '
                     'Si vas a pegar etiquetas mientras cuentas, escríbelo tú. No se puede repetir ni llevar espacios.'),
        ('  DESCRIPCION', 'Obligatoria. Qué es, con medida o lado si ayuda a distinguirlo (ej. PASTILLA FRENO DELANTERA DISCO).'),
        ('  CATEGORIA', 'Grupo para ordenar y contar por estante (FRENOS, ELECTRICO, MOTOR, CAUCHOS…). Usa siempre el mismo nombre.'),
        ('  MOTOS COMPATIBLES', 'Separadas por coma (ej. BERA SBR, EMPIRE HORSE 150, JAGUAR). El vendedor busca por moto.'),
        ('  PROVEEDOR / REF. PROVEEDOR', 'A quién se le compra y el código que usa ese proveedor. Opcional, sirve para reponer.'),
        ('  COSTO USD (PIEZA)', 'Lo que cuesta cada pieza. Si se compra por caja, divide el precio de la caja entre las piezas.'),
        ('  PRECIO DETAL USD', 'Precio de venta por pieza. Sin él, el producto se crea pero no se puede vender.'),
        ('  PRECIO MAYOR + CANT. MIN.', 'Precio por pieza cuando el cliente lleva la cantidad mínima o más. Van los dos juntos o ninguno.'),
        ('  STOCK CONTADO (PIEZAS)', 'Piezas que hay HOY en la tienda, contadas a mano. Si no hay, pon 0.'),
        ('  STOCK MINIMO (ALERTA)', 'Opcional. Con esta cantidad o menos el POS marca "stock bajo".'),
        ('Antes de subirla', 'Revisa la columna REVISAR: en rojo están los códigos repetidos y los precios incompletos.'),
        ('Cómo se sube', 'En el POS, como administrador: Ajustes → Catálogo en Excel → Subir plantilla llena. El POS muestra un resumen '
                         'y los errores por fila antes de aplicar. Las filas con error no se aplican; corrígelas y vuelve a subir el archivo.'),
        ('Importante', 'Súbela UNA vez para el inventario inicial. STOCK CONTADO reemplaza el stock del sistema: no vuelvas a subir '
                       'este archivo después de empezar a vender. La mercancía nueva se carga en Inventario → Entrada de mercancía.'),
        ('Después', 'Para cambiar precios en bloque: Ajustes → Catálogo en Excel → Descargar catálogo actual, cambia los precios y súbelo. '
                    'Las celdas vacías no cambian nada.'),
        ('', ''),
        ('RESUMEN', None),
        ('Productos', f'=COUNTA(Catalogo!B2:B{ult})'),
        ('Con precio detal', f'=COUNT(Catalogo!H2:H{ult})'),
        ('Piezas contadas', f'=SUM(Catalogo!K2:K{ult})'),
        ('Valor del inventario al costo (USD)', f'=SUM(Catalogo!N2:N{ult})'),
        ('Filas con algo que revisar', f'=SUMPRODUCT((Catalogo!B2:B{ult}<>"")*(LEN(Catalogo!O2:O{ult})>0))'),
    ]
    for i, (a, b) in enumerate(texto, 1):
        x = ins.cell(i, 1, a)
        x.font = Font(name=F, bold=not a.startswith('  '), size=13 if b is None else 10)
        x.alignment = Alignment(vertical='top')
        if b is not None:
            y = ins.cell(i, 2, b)
            y.font = Font(name=F, size=10)
            y.alignment = Alignment(wrap_text=True, vertical='top')
    ins['B23'].number_format = '#,##0.00'
    wb.active = 0
    wb.save(salida)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--ejemplo':
        crear(sys.argv[2], EJEMPLO)
    else:
        crear('datos/Plantilla_catalogo_inicial.xlsx')
