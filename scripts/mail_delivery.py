import json
import smtplib
import ssl
import sys
from email.message import EmailMessage

c=json.load(sys.stdin.buffer)
message=EmailMessage()
message["From"]=c.get("SMTP_FROM","")
message["To"]=c.get("SMTP_TO","")
message["Subject"]="Softline · сигнал продакту"
message.set_content(c.get("text",""))
tls=ssl.create_default_context()
port=int(c["SMTP_PORT"] or 587)
if c["SMTP_TLS"] == "plain":
    if (c.get("DATA_PROFILE") != "local" or c["SMTP_HOST"] not in ("127.0.0.1", "::1")
            or c.get("LOCAL_SMTP_TARGET") != f"{c['SMTP_HOST']}:{port}"
            or c.get("SMTP_USER") or c.get("SMTP_PASSWORD")):
        sys.exit("SMTP_TLS=plain требует локальный тестовый приёмник без авторизации.")
client = None


def rejected(codes):
    if codes and all(400 <= code < 500 for code in codes):
        sys.exit(75)
    if codes and all(400 <= code < 600 for code in codes):
        sys.exit(69)


try:
    if c["SMTP_TLS"] == "implicit":
        client = smtplib.SMTP_SSL(c["SMTP_HOST"], port, timeout=20, context=tls)
    else:
        client = smtplib.SMTP(c["SMTP_HOST"], port, timeout=20)
    if c["SMTP_TLS"] not in ("implicit", "plain"):
        client.starttls(context=tls)
    if c["SMTP_USER"]:
        client.login(c["SMTP_USER"], c["SMTP_PASSWORD"])
    if "--check" in sys.argv:
        client.noop()
    else:
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPException("SMTP accepted only some recipients")
except smtplib.SMTPRecipientsRefused as error:
    rejected([code for code, _ in error.recipients.values()])
    raise
except smtplib.SMTPResponseException as error:
    rejected([error.smtp_code])
    raise
finally:
    if client is not None:
        try:
            client.quit()
        except (OSError, smtplib.SMTPException):
            client.close()
