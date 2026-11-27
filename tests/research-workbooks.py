"""Small synthetic XLSX pack for the real Office import acceptance test."""
import io
import json
import sys
import zipfile
from xml.sax.saxutils import escape

SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
SHEET = 'worksheets/sheet1.xml'

def workbook(rows, title='Исследования'):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', f'<Types xmlns="{CONTENT_TYPES}">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   f'<Override PartName="/xl/{SHEET}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', f'<Relationships xmlns="{PACKAGE_REL}">'
                   f'<Relationship Id="r1" Type="{OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{SPREADSHEET}" xmlns:r="{OFFICE_REL}">'
                   f'<sheets><sheet name="{escape(title)}" sheetId="1" r:id="r1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', f'<Relationships xmlns="{PACKAGE_REL}">'
                   f'<Relationship Id="r1" Type="{OFFICE_REL}/worksheet" Target="{SHEET}"/></Relationships>')
        content = []
        for n, row in enumerate(rows, 1):
            cells = []
            for i, value in enumerate(row):
                address = f'{chr(65+i)}{n}'
                if isinstance(value, (int, float)):
                    cells.append(f'<c r="{address}"><v>{value}</v></c>')
                elif value:
                    cells.append(f'<c r="{address}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
            content.append(f'<row r="{n}">' + ''.join(cells) + '</row>')
        z.writestr('xl/' + SHEET, f'<worksheet xmlns="{SPREADSHEET}"><sheetData>' + ''.join(content) + '</sheetData></worksheet>')
    return data.getvalue()


items = json.loads(sys.stdin.buffer.read().decode('utf-8'))
if sys.argv[1:2] == ['--xlsx']:
    sys.stdout.buffer.write(workbook(items, *sys.argv[2:]))
else:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for item in items:
            z.writestr(item['file'], workbook(item['rows']))
    sys.stdout.buffer.write(archive.getvalue())
