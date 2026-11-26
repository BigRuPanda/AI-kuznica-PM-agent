from getpass import getpass
from config import save

if __name__=='__main__':
    print('Непустые значения заменят соответствующие настройки.')
    prompts = [('METRIKA_TOKEN','OAuth Метрики с правом metrika:read',True),('METRIKA_COUNTER','ID счётчика',False),
               ('METRIKA_STORE_GOALS','Пять ID целей по порядку через запятую',False),
               ('REDMINE_URL','Адрес Redmine',False),('REDMINE_PROJECT','Идентификатор проекта',False),
               ('REDMINE_API_KEY','Ключ Redmine',True),('REDMINE_TRACKER_ID','ID трекера, если нужен',False),
               ('REDMINE_PUBLIC_URL','Адрес Redmine, который откроется на телефоне',False)]
    values = {}
    for key,label,secret in prompts:
        value = (getpass if secret else input)(label+': ').strip()
        if value:
            values[key]=value
    if values:
        save(values)
        print('Сохранено.')
