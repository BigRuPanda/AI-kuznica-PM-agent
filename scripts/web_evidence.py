"""Read public search results and product cards, without making network requests."""
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser


def clean(value):
    return " ".join(str(value or "").split())


def search_results(xml):
    root = ET.fromstring(xml)
    error = root.find(".//error")
    if error is not None:
        if error.get("code") == "15":
            return []
        raise ValueError("Ошибка выдачи Яндекса: " + str(error.get("code", "")))
    items = []
    for doc in root.findall(".//doc"):
        def content(tag):
            el = doc.find(tag)
            return clean("".join(el.itertext())) if el is not None else ""
        passages = [clean("".join(p.itertext())) for p in doc.findall("passages/passage")]
        items.append(dict(url=content("url"), title=content("title")[:250],
                          snippet=(" ".join(passages) or content("headline"))[:750]))
    return items


class PublicPage(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = []
        self.meta = {}
        self.item_prices = set()
        self.item_currencies = set()
        self.links = []
        self.anchor = None
        self.in_title = False
        self.skip = ""
        self.product_data = []
        self.structured = False
        self.script_text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.skip:
            return
        if tag in ("script", "style"):
            self.skip = tag
            self.structured = tag == "script" and a.get("type", "").lower() == "application/ld+json"
            self.script_text = []
        elif tag == "title":
            self.in_title = True
        elif tag == "meta":
            if a.get("itemprop") == "price" and a.get("content"):
                self.item_prices.add(a["content"])
            if a.get("itemprop") == "priceCurrency" and a.get("content"):
                self.item_currencies.add(a["content"])
            key = a.get("property") or a.get("name")
            if key:
                self.meta[key.lower()] = a.get("content") or ""
        elif tag == "a" and a.get("href"):
            self.anchor = [a["href"], []]
            self.links.append(self.anchor)

    def handle_data(self, data):
        if self.skip:
            if self.structured:
                self.script_text.append(data)
        elif self.in_title:
            self.title.append(data)
        elif self.anchor:
            self.anchor[1].append(data)

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip:
                if self.structured:
                    try:
                        self.product_data.append(json.loads("".join(self.script_text)))
                    except ValueError:
                        pass
                self.skip = ""
                self.structured = False
        elif tag == "title":
            self.in_title = False
        elif tag == "a":
            self.anchor = None


def products(data):
    if isinstance(data, list):
        for item in data:
            yield from products(item)
    elif isinstance(data, dict):
        kinds = data.get("@type", [])
        if "Product" in (kinds if isinstance(kinds, list) else [kinds]):
            yield data
        yield from products(data.get("@graph", []))


def inspect_html(html):
    page = PublicPage()
    page.feed(html)
    title = clean(" ".join(page.title) or page.meta.get("og:title"))
    records = list(products(page.product_data))
    product = records[0] if len(records) == 1 else {}
    description = clean(product.get("description") or page.meta.get("description"))
    return dict(title=title[:450], description=description[:650],
                sku=clean(product.get("sku"))[:100], name=clean(product.get("name"))[:400],
                links=[[href, clean(" ".join(label))[:250]] for href, label in page.links][:1000],
                offers=product.get("offers") or {},
                itemPrice=next(iter(page.item_prices)) if len(page.item_prices) == 1 else None,
                itemCurrency=next(iter(page.item_currencies)) if len(page.item_currencies) == 1 else None)


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = []
        self.title = []
        self.text = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "template", "svg"):
            self.skip.append(tag)
        if tag == "title":
            self.in_title = True
        if tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3"):
            self.text.append("\n")

    def handle_endtag(self, tag):
        if self.skip and tag == self.skip[-1]:
            self.skip.pop()
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if not self.skip:
            if self.in_title:
                self.title.append(data)
            else:
                self.text.append(data)

def page_text(html):
    page = PageText()
    page.feed(html)
    lines = [clean(line) for line in "".join(page.text).splitlines()]
    return {"title": clean(" ".join(page.title))[:300], "text": "\n".join(filter(None, lines))[:65000]}

if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    try:
        result = search_results(raw) if sys.argv[1] == "xml" else (page_text if sys.argv[1] == "page" else inspect_html)(raw.decode("utf-8"))
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    except (ET.ParseError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
