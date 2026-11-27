"""Read official Office evidence from stdin. Emit structured facts, never expand ZIPs to disk."""
import io
import json
import posixpath
import re
import sys
import zipfile
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")
LIMIT = 100 * 1024 * 1024
TABLES = {"Продажи": "sales", "Метрики_данные": "metrics", "Метрики_справочник": "dictionary",
          "Релизы": "releases", "Бэклог_задачи": "backlog"}
EXCLUDE = {"README", "Эталонный_кейс", "Исследования", "Конкурентный_анализ"}
THEMES = [
    ("Kaspersky", r"kaspersky|каспер"), ("Astra Linux", r"астра|astra linux"),
    ("покупка через менеджера", r"через менеджер|только менеджер"),
    ("сложность выбора версии", r"запутанн.{0,35}верси|сложн.{0,30}(?:лицензи|подбор|выбор)"),
    ("консультация при подборе", r"консультац.{0,65}(?:выбор|подбор)|помощ.{0,30}подбор"),
    ("условия оплаты", r"отсрочк|постоплат"), ("прозрачность цены", r"прозрачн.{0,20}цен|скрыт.{0,20}цен"),
    ("закрывающие документы", r"закрывающ.{0,10}документ"), ("повторная покупка", r"повторн.{0,15}(?:покуп|заказ)"),
    ("рекомендации", r"рекомендац"), ("лицензии", r"лицензи")]
CONTACT = re.compile(r"[\w.+-]+@[\w.-]+|\+7[\s()\d-]{9,}|\bИНН\b", re.I)

# Verbatim excerpts are opt-in: every word in the whole cell must be non-identifying.
# Other cells contribute only the existing thematic labels.
INTERVIEW_WORDS = set("""
я мы клиент покупатель клиенты он они через только или и а в на по из за у с со при
не да нет когда если как что для без часто иногда обычно всегда сложно трудно удобно
выбрать выбор выбора выборе подобрать подбор подбора нужную версию версии версий
лицензию лицензии лицензий лицензия условия условиям цена цены срок редакцию
менеджера менеджер менеджеру менеджером закупает покупает купить купили покупаем
закупки заказ заказа онлайн самостоятельно консультация помощь информация информации
нехватка недостаточно сложным лицензиям идеальный вариант остальное сдерживает
запутанная политика по критика программное обеспечение касперский kaspersky astra
linux cyberbackup
""".split())

def interview_excerpt(value):
    if len(value) > 500 or re.search(r"[^\w\s.,:;!?()«»\"—–-]|[\d_]", value):
        return None
    if not set(re.findall(r"[\w]+", value.casefold())).issubset(INTERVIEW_WORDS):
        return None
    for phrase in re.split(r"[.!?;\n]", value):
        phrase = phrase.strip()
        if 15 <= len(phrase) <= 170 and re.search(r"сложн|запутан|выбор|подбор|нехватк", phrase, re.I):
            return phrase
    return None

def price_comparison(headers, cells):
    fields = {name: cells.get(col) for col, name in headers.items()}
    match = fields.get("Сопоставимый продукт у конкурента")
    if match not in ("Да", "Частично"):
        return None
    merchant, product = fields.get("Конкурент"), fields.get("Продукт")
    offered, store = fields.get("Цена конкурента, ₽"), fields.get("Цена store.softline.ru, ₽")
    checked = fields.get("Дата проверки")
    if not isinstance(merchant, str) or not isinstance(product, str) or not isinstance(checked, (int, float)):
        return None
    if not all(isinstance(v, (int, float)) and v > 0 for v in (offered, store)):
        return None
    if not 1 <= checked < 100000:
        return None
    description = fields.get("Описание сравниваемого продукта")
    sku = re.search(r"артикул\s*:\s*([\w.-]+)", description or "", re.I)
    return {"merchant": merchant, "product": product, "competitorPrice": offered, "storePrice": store,
            "license": fields.get("Редакция / лицензия"), "terms": fields.get("Срок / кол-во"),
            "match": match, "sku": sku.group(1) if sku else None,
            "checked": (datetime(1899,12,30) + timedelta(days=checked)).date().isoformat()}

def read(z, key):
    if z.getinfo(key).file_size > LIMIT:
        raise ValueError("Слишком большой файл внутри архива")
    return z.read(key)

def xml(z, key):
    return ET.fromstring(read(z, key))

def text_nodes(el):
    return "".join(t.text or "" for t in el.findall(".//{*}t"))

def cell_value(c, strings):
    raw = c.findtext("{*}v")
    kind = c.get("t")
    if kind == "s":
        return strings[int(raw)]
    if kind == "inlineStr":
        return text_nodes(c)
    if raw is None or kind == "e":
        return None
    if kind in ("str", "d", "b"):
        return raw
    try:
        return float(raw) if "." in raw or "e" in raw.lower() else int(raw)
    except ValueError:
        return raw

def sheet_rows(z, path, strings):
    # Some source sheets contain a million empty formatted rows.
    data = read(z, path)
    for match in re.finditer(rb"<row\b[^>]*?(?<!/)>(.*?)</row>", data, re.S):
        chunk = match[1]
        if not (b"<v" in chunk or b"<is" in chunk):
            continue
        cells = {}
        for item in re.finditer(rb"<c\b[^>]*?(?<!/)>.*?</c>", chunk, re.S):
            c = ET.fromstring(item[0])
            value = cell_value(c, strings)
            address = c.get("r", "")
            if value is not None and value != "" and address:
                cells[re.sub(r"\d", "", address)] = value
        if cells:
            yield int(re.search(rb'\br="(\d+)"',match[0].split(b">",1)[0])[1]), cells

def normalize(row):
    for k in ["date","week_start","created_date","closed_date","release_date"]:
        if isinstance(row.get(k), (int,float)):
            row[k] = (datetime(1899,12,30)+timedelta(days=row[k])).date().isoformat()
    return row

def book(z, name):
    strings = [text_nodes(item) for item in xml(z,"xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in z.namelist() else []
    sheets = xml(z,"xl/workbook.xml").findall(".//{*}sheet")
    relations = {r.get("Id"):r.get("Target") for r in xml(z,"xl/_rels/workbook.xml.rels")}
    official = any(s.get("name") in TABLES for s in sheets)
    competitor = any(s.get("name")=="0_Конкуренты_Продукты" for s in sheets) or "конкурент" in name.lower()
    facts = []
    for sheet in sheets:
        title=sheet.get("name")
        if title in EXCLUDE or (official and title not in TABLES):
            continue
        rel=next(v for k,v in sheet.attrib.items() if k.endswith("}id"))
        target=relations[rel]
        path=target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl",target))
        headers={}
        for n,cells in sheet_rows(z,path,strings):
            if title in TABLES:
                if not headers:
                    headers=cells
                    continue
                row=normalize({key:cells.get(col) for col,key in headers.items()})
                if not cells.get("A"):
                    continue
                facts.append({"kind":TABLES[title],"loc":f"{title}!A{n}","row":row})
            elif competitor:
                line=" · ".join(str(v)[:320] for v in cells.values())[:1600]
                if not CONTACT.search(line):
                    fact={"kind":"competitor","loc":f"{title}!A{n}","text":line}
                    if "Сопоставимый продукт у конкурента" in cells.values():
                        headers=cells
                    elif headers:
                        comparison=price_comparison(headers,cells)
                        if comparison: fact["comparison"]=comparison
                    facts.append(fact)
            elif n>=3:
                for col,value in cells.items():
                    if col in ("A","B") or not isinstance(value,str):
                        continue
                    tags=[label for label,pattern in THEMES if re.search(pattern,value,re.I)]
                    if tags:
                        text="Темы ответа: "+", ".join(tags)
                        excerpt=interview_excerpt(value)
                        if excerpt: text+="\nФрагмент записи: "+excerpt
                        facts.append({"kind":"interview","loc":f"{title}!{col}{n}","text":text})
    return facts

def extract(data, name, depth=0):
    if depth>2:
        raise ValueError("Слишком много вложенных архивов")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist())>10000 or sum(f.file_size for f in z.infolist())>520*1024*1024:
            raise ValueError("Превышен лимит распаковки")
        if "xl/workbook.xml" in z.namelist():
            return [{"file":name,"facts":book(z,name)}]
        if "ppt/presentation.xml" in z.namelist():
            facts=[]
            for p in z.namelist():
                match=re.fullmatch(r"ppt/slides/slide(\d+)\.xml",p)
                if match:
                    line=" ".join(t.text or "" for t in xml(z,p).findall(".//{*}t"))
                    facts.append({"kind":"competitor","loc":"Слайд "+match[1],"text":CONTACT.sub("[скрыто]",line)[:5000]})
            return [{"file":name,"facts":facts}]
        out=[]
        for item in z.infolist():
            if item.filename.lower().endswith((".xlsx",".pptx",".zip")):
                out.extend(extract(read(z,item.filename),posixpath.basename(item.filename),depth+1))
            elif item.filename.lower().endswith((".pdf",".docx")):
                # Keep supporting documents in the inventory. Account instructions may contain credentials.
                out.append({"file":posixpath.basename(item.filename),"facts":[],"role":"reference"})
        if not out:
            raise ValueError("В файле нет поддерживаемых таблиц или презентаций")
        return out

try:
    result=extract(sys.stdin.buffer.read(32*1024*1024+1),sys.argv[1])
    print(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(",",":")))
except (ValueError, KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
    sys.exit("Не удалось прочитать Office-документ: "+str(exc)[:200])
