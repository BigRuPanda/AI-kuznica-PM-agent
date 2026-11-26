import getpass
import secrets
import sys
import time
import webbrowser

from config import save
from providers import ServiceError, telegram


def pair(token, code, open_browser=True, wait_seconds=600):
    bot = telegram('getMe',{},token)
    if telegram('getWebhookInfo',{},token).get('url'):
        raise ValueError('У бота уже установлен webhook. Используйте отдельного бота или задайте TELEGRAM_CHAT_ID вручную.')
    url = 'https://t.me/'+bot['username']+'?start='+code
    print('Откройте ссылку своим аккаунтом и нажмите «Старт» в личном чате.\n'+url,flush=True)
    if open_browser and sys.stdin.isatty():
        webbrowser.open(url)
    deadline = time.monotonic()+wait_seconds
    offset = None
    while time.monotonic()<deadline:
        args = dict(timeout=2,allowed_updates=['message'])
        if offset is not None:
            args['offset'] = offset
        try:
            updates = telegram('getUpdates',args,token,timeout=15)
        except ServiceError as exc:
            if exc.code not in (0,429) and exc.code<500:
                raise
            time.sleep(min(max(1,exc.retry_after) if exc.code==429 else 2,
                           max(0,deadline-time.monotonic())))
            continue
        for update in updates:
            offset = update['update_id']+1
            message = update.get('message',{})
            chat = message.get('chat',{})
            if (chat.get('type')=='private' and chat.get('id')==message.get('from',{}).get('id')
                    and message.get('text')=='/start '+code):
                save(dict(TELEGRAM_BOT_TOKEN=token,TELEGRAM_CHAT_ID=str(chat['id'])))
                print('Личный чат привязан. Запущенный Bridge увидит настройки при следующей доставке.')
                return
    raise ValueError('Время привязки истекло. Запустите подключение ещё раз.')


def main():
    token = getpass.getpass('Токен от BotFather (скрытый ввод): ').strip()
    pair(token,secrets.token_urlsafe(12))


if __name__=='__main__':
    try:
        main()
    except (ValueError,OSError,KeyboardInterrupt) as exc:
        sys.exit(str(exc) or 'Подключение прервано.')
