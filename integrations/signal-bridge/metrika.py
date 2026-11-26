import datetime as dt
import urllib.parse
from config import setting
from providers import request_json

def fetch():
    token = setting("METRIKA_TOKEN")
    if not token:
        raise ValueError("Для свежего отчёта нужен токен metrika:read. Укажите METRIKA_TOKEN.")
    counter = setting("METRIKA_COUNTER")
    ids = [x.strip() for x in setting("METRIKA_STORE_GOALS").split(",")]
    if not counter.isdigit() or len(ids)!=5 or not all(i.isdigit() for i in ids) or len(set(ids))!=5:
        raise ValueError("Нужны номер счётчика и пять разных ID целей витрины.")
    end = dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).date()-dt.timedelta(days=1)
    start = end-dt.timedelta(days=13)
    params = dict(ids=counter,date1=str(start),date2=str(end),dimensions="ym:s:date",accuracy="full",timezone="+03:00",
                  metrics=",".join(["ym:s:visits"]+["ym:s:goal"+i+"visits" for i in ids]),
                  filters="ym:s:startURL!@'signal_qa='",limit=100)
    url="https://api-metrika.yandex.net/stat/v1/data?"+urllib.parse.urlencode(params)
    data=request_json(url,{"Authorization":"OAuth "+token})
    periods=summarize(data,start,end)
    web=setting("METRIKA_REPORT_URL") or "https://metrika.yandex.ru/stat/conversion_rate?id="+counter
    if urllib.parse.urlsplit(web).netloc!="metrika.yandex.ru" or not web.startswith("https://"):
        raise ValueError("METRIKA_REPORT_URL должен вести на HTTPS-отчёт metrika.yandex.ru.")
    return dict(counter=counter,goals=ids,start=str(start),end=str(end),periods=periods,api=url,
                web=web+("&" if "?" in web else "?")+"period="+str(start)+"%3A"+str(end))


def summarize(data,start,end):
    rows=data.get("data")
    if not isinstance(rows,list) or data.get("sampled") is not False or data.get("total_rows")!=len(rows):
        raise ValueError("API вернул неполный или семплированный отчёт.")
    periods=[[0]*6 for _ in range(2)]
    days=set()
    for row in rows:
        day=dt.date.fromisoformat(row["dimensions"][0]["name"])
        counts=row["metrics"]
        if (not start<=day<=end or day in days or len(counts)!=6 or
                any(type(v) not in (int,float) or v<0 or not float(v).is_integer() for v in counts) or
                any(v>counts[0] for v in counts[1:])):
            raise ValueError("Некорректная дата или число визитов в отчёте.")
        days.add(day)
        period=periods[(day-start).days//7]
        for i,v in enumerate(counts):
            period[i]+=int(v)
    if data.get("totals")!=[a+b for a,b in zip(*periods)]:
        raise ValueError("Суммы дневных строк расходятся с итогом API.")
    return periods


def assess(report,threshold,minimum):
    base,current=report["periods"]
    if min(base[0],current[0])<minimum or base[-1]==0:
        return "Мало данных",None
    delta=100*((current[-1]/current[0])/(base[-1]/base[0])-1)
    alarm=100*current[-1]*base[0] <= (100-threshold)*base[-1]*current[0]
    return ("Сигнал" if alarm else "Наблюдение"),round(delta,2)
