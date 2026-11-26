import json
import smtplib
import ssl
import sys
from email.message import EmailMessage

c=json.load(sys.stdin)
message=EmailMessage()
message["From"]=c.get("SMTP_FROM","")
message["To"]=c.get("SMTP_TO","")
message["Subject"]="Softline · сигнал продакту"
message.set_content(c.get("text",""))
tls=ssl.create_default_context()
port=int(c["SMTP_PORT"] or 587)
if c["SMTP_TLS"]=="implicit":
    client=smtplib.SMTP_SSL(c["SMTP_HOST"],port,timeout=20,context=tls)
else:
    client=smtplib.SMTP(c["SMTP_HOST"],port,timeout=20)
with client:
    if c["SMTP_TLS"]!="implicit":
        client.starttls(context=tls)
    if c["SMTP_USER"]:
        client.login(c["SMTP_USER"],c["SMTP_PASSWORD"])
    if "--check" in sys.argv:
        client.noop()
    else:
        client.send_message(message)
