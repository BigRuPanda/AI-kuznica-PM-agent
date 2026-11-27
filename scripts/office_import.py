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
sys.stderr.reconfigure(encoding="utf-8")
LIMIT = 100 * 1024 * 1024
TABLES = {"Продажи": "sales", "Метрики_данные": "metrics", "Метрики_справочник": "dictionary",
          "Релизы": "releases", "Бэклог_задачи": "backlog"}
EXCLUDE = {"README", "Эталонный_кейс", "Конкурентный_анализ"}
OFFICIAL_INTERVIEWS = {"E-com ответы нап впоросы по когортам.xlsx", "Отток клиентов.xlsx", "Сервисные преимущества.xlsx"}
EXCERPT_COLUMNS = {
    "обезличенная выдержка": "excerpt", "anonymized_excerpt": "excerpt",
    "вопрос": "question", "question": "question", "продукт": "product", "product": "product",
    "дата": "date", "date": "date", "исходная книга": "sourceFile", "source_file":"sourceFile",
    "ячейка источника": "sourceLoc", "source_location":"sourceLoc",
    "проверяемая гипотеза":"hypothesis", "hypothesis":"hypothesis",
    "связь с гипотезой":"relation", "relation":"relation",
}
THEMES = [
    ("Kaspersky", r"kaspersky|каспер"), ("Astra Linux", r"астра|astra linux"),
    ("покупка через менеджера", r"через менеджер|только менеджер"),
    ("сложность выбора версии", r"запутанн.{0,35}верси|сложн.{0,30}(?:лицензи|подбор|выбор)"),
    ("консультация при подборе", r"консультац.{0,65}(?:выбор|подбор)|помощ.{0,30}подбор"),
    ("условия оплаты", r"отсрочк|постоплат"), ("прозрачность цены", r"прозрачн.{0,20}цен|скрыт.{0,20}цен"),
    ("закрывающие документы", r"закрывающ.{0,10}документ"), ("повторная покупка", r"повторн.{0,15}(?:покуп|заказ)"),
    ("рекомендации", r"рекомендац"), ("лицензии", r"лицензи")]
CONTACT = re.compile(r"[\w.+-]+@[\w.-]+|\+7[\s()\d-]{9,}|\bИНН\b", re.I)
PRIVATE = re.compile(r"[\w.+-]+@[\w.-]+|(?:\+7|8)[\s()\d-]{9,}|\bИНН\s*[:№\d]|\b(?:\d{10}|\d{12})\b|https?://", re.I)

def excerpt_row(cells, columns, title, n, epoch):
    location = f"{title}!{columns['excerpt']}{n}"
    row = {key: cells[col] for key, col in columns.items() if col in cells}
    if not row.get("excerpt"):
        return None
    if not isinstance(row["excerpt"], str) or len(row["excerpt"]) > 3000:
        raise ValueError("Укажите текст обезличенной выдержки до 3000 символов: " + location)
    for key in ("excerpt","question","product","sourceFile","sourceLoc","hypothesis"):
        if key in row:
            row[key] = str(row[key]).strip()
            if PRIVATE.search(row[key]):
                raise ValueError("Обезличьте выдержку и её описание: " + location)
    if not row["excerpt"]:
        return None
    relation = str(row.get("relation", "")).strip().lower() or "упоминание"
    if relation not in ("упоминание", "подтверждает", "опровергает"):
        raise ValueError("Укажите связь: упоминание, подтверждает или опровергает: " + location)
    if relation != "упоминание" and not row.get("hypothesis"):
        raise ValueError("Укажите проверяемую гипотезу для оценки свидетельства: " + location)
    row["relation"] = relation
    if bool(row.get("sourceFile")) != bool(row.get("sourceLoc")):
        raise ValueError("Укажите исходную книгу и ячейку вместе: " + location)
    if row.get("sourceLoc") and not re.fullmatch(r".{1,100}!\$?[A-Z]{1,3}\$?[1-9]\d{0,6}", row["sourceLoc"]):
        raise ValueError("Ожидается адрес вида Лист!C3: " + location)
    if row.get("date") is not None:
        try:
            value = str(normalize(row, epoch)["date"]).strip()
            stamp = datetime.strptime(value, "%d.%m.%Y") if re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{4}", value) else datetime.fromisoformat(value)
            row["date"] = stamp.date().isoformat()
        except (ValueError, OverflowError):
            raise ValueError("Проверьте дату исследования: " + location)
    return {"kind":"interview","loc":location,"row":row}

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

# Index structured research answers. Contact fields, recordings and raw transcripts
# are outside the research corpus. A sheet row links answers from the same interview.
PRIVATE_FIELD = re.compile(
    r"контакт|телефон|мобильн(?:ый|ого)\b|телеграм|telegram|whatsapp|viber|skype|соцсет|никнейм|"
    r"e[- ]?mail|почт[аовы]|адрес|фамили|отчеств|имя\b|ф[\W_]*и[\W_]*о\b|название компании|"
    r"\b(?:name|phone|mobile|contact|handle|username|login|address|employer|company name)\b|"
    r"инн|ссылка на|транскри|расшифров|запись интервью|реквизит|пароль|логин", re.I)
RESEARCH_FIELD = re.compile(
    r"роль\b|должност|модел|продукт|покуп|заказ|поставщик|цен[ауы]|лицензи|выбор|закуп|"
    r"оплат|достав|предпочтен|преимуществ|проблем|потребност|затруднен|возражен|"
    r"\b(?:product|purchase|buying|role|supplier|price|licen[cs]e|payment|delivery)\b", re.I)
PRIVATE_VALUE = re.compile(r"https?://\S+|[\w.+-]+@[\w.-]+|(?<!\w)(?:\+7|8)[\s()-]*(?:\d[\s()-]*){10}(?!\d)|\b\d{9,}\b|@[\w.]+|\b(?:ООО|АО|ПАО|ИП)\s+[«\"][^»\"]+[»\"]", re.I)
PERSON = re.compile(r"\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?\b|\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.")

def research_detail(field, value, identifiers):
    if not isinstance(field, str) or PRIVATE_FIELD.search(field) or not RESEARCH_FIELD.search(field) or not isinstance(value, str):
        return None
    if len(field) > 500 or re.search(r"пароль|паспорт|транскрипт|расшифровка интервью|(?:^|\n)\s*(?:интервьюер|респондент)\s*:", value, re.I):
        return None
    cleaned = PERSON.sub("[скрыто]", PRIVATE_VALUE.sub("[скрыто]", value)).strip()
    for word in identifiers:
        cleaned = re.sub(r"\b"+re.escape(word)+r"\b", "[скрыто]", cleaned, flags=re.I)
    if not cleaned or cleaned == "[скрыто]":
        return None
    return {"field": field.strip(), "answer": cleaned}

def price_comparison(headers, cells, epoch):
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
            "checked": (epoch + timedelta(days=checked)).date().isoformat()}

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

def normalize(row, epoch):
    for k in ["date","week_start","created_date","closed_date","release_date"]:
        if isinstance(row.get(k), (int,float)):
            row[k] = (epoch + timedelta(days=row[k])).date().isoformat()
    return row

def hyperlink_targets(z, path):
    rels = posixpath.join(posixpath.dirname(path), "_rels", posixpath.basename(path) + ".rels")
    if rels not in z.namelist():
        return {}
    external = {r.get("Id"): r.get("Target") for r in xml(z, rels)
                if r.get("TargetMode") == "External" and r.get("Type", "").endswith("/hyperlink")}
    if not external:
        return {}
    targets = {}
    for _, element in ET.iterparse(io.BytesIO(read(z, path)), events=("end",)):
        if element.tag.rsplit("}", 1)[-1] == "hyperlink":
            rel = next((v for k, v in element.attrib.items() if k.endswith("}id")), None)
            if rel in external:
                targets[element.get("ref")] = external[rel]
        element.clear()
    return targets

def row_links(title, n, cells, targets, headers):
    links = []
    for col, value in cells.items():
        if re.search(r"контакт|расшифров|запись интервью|пароль|логин|транскрипт", str(headers.get(col, "")), re.I):
            continue
        address = col + str(n)
        url = targets.get(address, value)
        if isinstance(url, str) and len(url) <= 2048 and re.fullmatch(r"https?://[^\s<>]+", url.strip(), re.I):
            links.append({"loc": title + "!" + address, "url": url.strip()})
    return links

def book(z, name):
    strings = [text_nodes(item) for item in xml(z,"xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in z.namelist() else []
    workbook = xml(z,"xl/workbook.xml")
    props = workbook.find("{*}workbookPr")
    epoch = datetime(1904, 1, 1) if props is not None and props.get("date1904") in ("1", "true") else datetime(1899, 12, 30)
    sheets = workbook.findall(".//{*}sheet")
    relations = {r.get("Id"):r.get("Target") for r in xml(z,"xl/_rels/workbook.xml.rels")}
    official = any(s.get("name") in TABLES for s in sheets)
    competitor = any(s.get("name")=="0_Конкуренты_Продукты" for s in sheets) or "конкурент" in name.lower()
    facts = []
    for sheet in sheets:
        title=sheet.get("name")
        if title in EXCLUDE or (official and title not in TABLES and title != "Исследования"):
            continue
        rel=next(v for k,v in sheet.attrib.items() if k.endswith("}id"))
        target=relations[rel]
        path=target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl",target))
        headers={}
        targets = hyperlink_targets(z, path)
        reference_cols = set()
        survey = False
        excerpt_cols = None
        for n,cells in sheet_rows(z,path,strings):
            prior = len(facts)
            if title in TABLES:
                if not headers:
                    headers=cells
                    continue
                row=normalize({key:cells.get(col) for col,key in headers.items()}, epoch)
                if not cells.get("A"):
                    continue
                facts.append({"kind":TABLES[title],"loc":f"{title}!A{n}","row":row})
            elif excerpt_cols is not None:
                item = excerpt_row(cells, excerpt_cols, title, n, epoch)
                if item:
                    facts.append(item)
            elif n <= 8 and "excerpt" in [EXCERPT_COLUMNS.get(str(v).strip().lower()) for v in cells.values()]:
                excerpt_cols = {EXCERPT_COLUMNS[str(v).strip().lower()]:col for col,v in cells.items()
                                if str(v).strip().lower() in EXCERPT_COLUMNS}
            elif title == "Исследования":
                continue
            elif reference_cols:
                usable = {col:value for col,value in cells.items() if col in reference_cols}
                links = row_links(title, n, usable, targets, headers)
                for link in links:
                    facts.append({"kind":"reference", "loc":link["loc"], "text": str(usable[re.sub(r".*!|[0-9]", "", link["loc"])])[:300], "links":[link]})
            elif competitor:
                line=" · ".join(str(v)[:320] for v in cells.values())[:1600]
                if not CONTACT.search(line):
                    fact={"kind":"competitor","loc":f"{title}!A{n}","text":line}
                    if "Сопоставимый продукт у конкурента" in cells.values():
                        headers=cells
                    elif headers:
                        comparison=price_comparison(headers,cells,epoch)
                        if comparison: fact["comparison"]=comparison
                        if "Цена конкурента, ₽" in headers.values():
                            fields={label:cells.get(col) for col,label in headers.items()}
                            if isinstance(fields.get("Конкурент"),str) and isinstance(fields.get("Продукт"),str):
                                fact["prices"]={k:fields.get(k) for k in ("Конкурент","Продукт","Описание сравниваемого продукта",
                                    "Сопоставимый продукт у конкурента","Цена конкурента, ₽","Цена store.softline.ru, ₽","Срок / кол-во")}
                                checked=fields.get("Дата проверки")
                                if isinstance(checked,(float,int)) and 1<=checked<100000:
                                    fact["prices"]["Дата проверки"]=(epoch+timedelta(days=checked)).date().isoformat()
                    facts.append(fact)
            else:
                if n <= 6 and not survey:
                    headings=[v for v in cells.values() if isinstance(v,str)]
                    survey=(len(headings)>=4 and (any(re.match(r"^(?:роль\b|должность\b|имя,|состав заказа$|выбор поставщика$|модель покупки$)",h,re.I)
                                                      for h in headings) or sum("?" in h for h in headings)>=3))
                    if survey:
                        headers=cells
                        continue
                    if not any(PRIVATE_FIELD.search(h) for h in headings) and "интервью" not in (name+" "+title).lower():
                        reference_cols={col for col,value in cells.items() if isinstance(value,str) and
                            re.fullmatch(r"(?:url|сайт|источник|ссылк[аи]|страница|карточка)(?: (?:на )?(?:источник|товар|продукт|сайт|страницу))?",value.strip(),re.I)}
                        if reference_cols:
                            headers=cells
                            continue
                    if n<=2:
                        continue
                identifiers = {word for col,value in cells.items() if isinstance(value,str) and
                               PRIVATE_FIELD.search(str(headers.get(col,"")))
                               for word in re.findall(r"\b[\w.-]{3,}\b",value)}
                for col,value in cells.items():
                    if not isinstance(value,str):
                        continue
                    if survey and PRIVATE_FIELD.search(str(headers.get(col, ""))):
                        continue
                    detail=research_detail(headers.get(col),value,identifiers) if survey else None
                    tags=[label for label,pattern in THEMES if re.search(pattern,value,re.I)] if n>=3 and col not in ("A","B") else []
                    if detail or tags:
                        text="Темы ответа: "+", ".join(tags) if tags else detail["field"]
                        excerpt=interview_excerpt(value) if tags else None
                        if excerpt: text+="\nФрагмент записи: "+excerpt
                        fact={"kind":"interview","loc":f"{title}!{col}{n}","text":text}
                        if detail: fact["detail"]=detail
                        facts.append(fact)
            if (competitor or title in TABLES) and len(facts) > prior and facts[-1]["kind"] != "interview":
                links = row_links(title, n, cells, targets, headers)
                if links:
                    facts[-1]["links"] = links
    return facts

def extract(data, name, depth=0, include_references=False):
    if depth>2:
        raise ValueError("Слишком много вложенных архивов")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist())>10000 or sum(f.file_size for f in z.infolist())>520*1024*1024:
            raise ValueError("Превышен лимит распаковки")
        if "xl/workbook.xml" in z.namelist():
            doc = {"file":name,"facts":book(z,name)}
            leaf = posixpath.basename(name)
            if leaf in OFFICIAL_INTERVIEWS and name != leaf:
                doc["legacyInterviewFile"] = leaf
            return [doc]
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
            child_name = item.filename if depth == 0 else name + "/" + item.filename
            suffix = item.filename.lower()
            if suffix.endswith((".xlsx",".pptx",".zip")):
                out.extend(extract(read(z,item.filename),child_name,depth+1,include_references))
            elif include_references and suffix.endswith((".pdf",".docx")):
                out.append({"file":child_name,"facts":[],"role":"reference"})
        if not out:
            raise ValueError("В файле нет поддерживаемых таблиц или презентаций")
        return out

try:
    result=extract(sys.stdin.buffer.read(32*1024*1024+1),sys.argv[1],include_references="--references" in sys.argv[2:])
    print(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(",",":")))
except (ValueError, KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
    sys.exit("Не удалось прочитать Office-документ: "+str(exc)[:200])
