"""Genera src/data/catalogo-gp.json desde la lista de precios del importador GP.
Uso: python3 scripts/catalogo.py "LISTA DE PRECIO GPMOTOCYCLES.xlsx" > src/data/catalogo-gp.json
Toma CODIGO, MARCA QUE APLICA, DESCRIPCION, UND, CATEGORIA y PRECIO; las filas sin
precio son encabezados de familia."""
import json, re, sys
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1], data_only=True).active
out, fam, start = [], None, None
for i, r in enumerate(ws.iter_rows(values_only=True), 1):
    if start is None:
        if r[0] == 'CODIGO': start = i
        continue
    cod, marca, desc, und, cat, precio = (list(r) + [None] * 6)[:6]
    if cod is None and desc is None: continue
    if precio is None and desc and not marca and not und:
        fam = str(desc).strip(); continue
    if desc is None or precio is None: continue
    pres = str(und).strip().upper() if und else None
    m = re.match(r'^1\s*X\s*(\d+)$', pres or '')
    out.append({'c': str(cod).strip(), 'f': fam, 'm': str(marca).strip() if marca else None,
                'd': ' '.join(str(desc).split()), 'p': pres, 'u': str(cat).strip() if cat else None,
                'b': int(m.group(1)) if m else None, 'k': round(float(precio), 2)})
json.dump(out, sys.stdout, ensure_ascii=False, separators=(',', ':'))
