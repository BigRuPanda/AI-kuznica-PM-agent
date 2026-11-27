"""Resolve an ambiguous delivery after checking the destination chat."""
import argparse
import bridge


def resolve(event_id, message_id):
    with bridge.db() as c:
        c.execute('BEGIN IMMEDIATE')
        row=c.execute('SELECT state FROM events WHERE id=?',(event_id,)).fetchone()
        if not row or row['state']!='uncertain':
            raise ValueError('Решение доступно для события со статусом uncertain.')
        if message_id is None:
            c.execute("UPDATE events SET state='pending',ready=0,error=NULL WHERE id=?",(event_id,))
        elif message_id>0:
            c.execute("UPDATE events SET state='sent',message_id=?,error=NULL WHERE id=?",(message_id,event_id))
        else:
            raise ValueError('Укажите положительный номер сообщения.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('event_id')
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--confirmed-absent',action='store_true')
    group.add_argument('--observed-message-id',type=int)
    args=parser.parse_args()
    resolve(args.event_id,args.observed_message_id)
