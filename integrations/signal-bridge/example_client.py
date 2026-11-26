"""Import these calls in the backend that serves the UI or the agent."""
import json
from urllib import error, request


def call(path, payload=None, base='http://127.0.0.1:18880'):
    data = json.dumps(payload,ensure_ascii=False).encode() if payload is not None else None
    req = request.Request(base+path,data=data,headers={'Content-Type':'application/json'})
    try:
        with request.build_opener(request.ProxyHandler({})).open(req,timeout=90) as response:
            return json.load(response)
    except error.HTTPError as exc:
        raise RuntimeError(json.load(exc).get('error',str(exc.code))) from None


def latest_report():
    return call('/reports/latest')


def publish_confirmed(reference, report_id, title, description):
    """Call after the user confirms the draft. Preserve the reference on retries."""
    return call('/tasks',dict(reference=reference,report_id=report_id,title=title,
                              description=description,confirmed=True))


if __name__=='__main__':
    print(json.dumps(call('/health'),ensure_ascii=False,indent=2))
