"""Resolve an ambiguous delivery after checking the destination chat."""
import argparse
import bridge
from providers import telegram_bot_id


def resolve(event_id, message_id, *, original_bot_id=None, original_chat_id=None):
    bridge.init()
    with bridge.db() as c:
        c.execute('BEGIN IMMEDIATE')
        row=c.execute('SELECT state,telegram_bot_id,telegram_chat_id FROM events WHERE id=?',(event_id,)).fetchone()
        if not row or row['state']!='uncertain':
            raise ValueError('Решение доступно для события со статусом uncertain.')
        bot_id, chat_id = row['telegram_bot_id'], row['telegram_chat_id']
        if not bot_id or not chat_id:
            if not original_bot_id or not original_chat_id:
                raise ValueError('Исходный адрес доставки не сохранён. После проверки укажите '
                                 '--original-bot-id и --original-chat-id.')
            bot_id, chat_id = original_bot_id, original_chat_id
        elif (original_bot_id is not None or original_chat_id is not None) and (original_bot_id, original_chat_id)!=(bot_id, chat_id):
            raise ValueError(f'В событии сохранены бот {bot_id} и чат {chat_id}.')
        current_bot = telegram_bot_id(bridge.setting('TELEGRAM_BOT_TOKEN'))
        if (current_bot, bridge.setting('TELEGRAM_CHAT_ID'))!=(bot_id, chat_id):
            raise ValueError(f'Для сверки настройте исходные бот {bot_id} и чат {chat_id}.')

        if message_id is None:
            c.execute("""UPDATE events SET state='pending',ready=0,error=NULL,telegram_bot_id=?,telegram_chat_id=?
                WHERE id=?""",(bot_id,chat_id,event_id))
        elif type(message_id) is int and message_id>0:
            c.execute("""UPDATE events SET state='sent',message_id=?,error=NULL,telegram_bot_id=?,telegram_chat_id=?
                WHERE id=?""",(message_id,bot_id,chat_id,event_id))
        else:
            raise ValueError('Укажите положительный номер сообщения.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('event_id')
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--confirmed-absent',action='store_true')
    group.add_argument('--observed-message-id',type=int)
    parser.add_argument('--original-bot-id')
    parser.add_argument('--original-chat-id')
    args=parser.parse_args()
    try:
        resolve(args.event_id,args.observed_message_id,
                original_bot_id=args.original_bot_id,original_chat_id=args.original_chat_id)
    except ValueError as exc:
        parser.error(str(exc))
