"""Bootstrap only the bundled, loopback-bound Redmine compose project."""
import json
import secrets
import subprocess
import sys
import time
from urllib import request

from config import ROOT, save, saved


def setup():
    compose = ['docker','compose','-f',str(ROOT/'compose.yaml')]
    subprocess.run(compose+['up','-d'],check=True)
    for _ in range(90):
        try:
            with request.build_opener(request.ProxyHandler({})).open('http://127.0.0.1:18881/login',timeout=2):
                break
        except OSError:
            time.sleep(1)
    else:
        raise ValueError('Redmine не ответил на 127.0.0.1:18881.')
    settings = saved()
    addresses = {'REDMINE_URL':'http://127.0.0.1:18881','REDMINE_PROJECT':'signal-demo'}
    if settings.get('REDMINE_URL',addresses['REDMINE_URL'])!=addresses['REDMINE_URL']:
        raise ValueError('Уже настроен другой Redmine. Для демо задайте отдельный SIGNAL_BRIDGE_STATE.')
    passwords = {k:settings.get(k) or secrets.token_urlsafe(30)+'1aA' for k in ('DEMO_PASSWORD','DEMO_ADMIN_PASSWORD')}
    save(passwords)
    script = 'p_user, p_admin = '+json.dumps([passwords['DEMO_PASSWORD'],passwords['DEMO_ADMIN_PASSWORD']])+'''
Redmine::DefaultData::Loader.load('en') if Tracker.count == 0
Setting.rest_api_enabled = '1'
admin = User.find_by!(login: 'admin')
if admin.check_password?('admin')
  admin.password = admin.password_confirmation = p_admin
  admin.save!
end
project = Project.find_or_initialize_by(identifier: 'signal-demo')
if project.new_record?
  project.name = 'Signal demo'
  project.is_public = false
  project.enabled_module_names = ['issue_tracking']
  project.trackers = Tracker.sorted.to_a
  project.save!
end
user = User.find_or_initialize_by(login: 'signal-demo')
if user.new_record?
  user.assign_attributes(firstname: 'Signal', lastname: 'Demo', mail: 'signal-demo@example.invalid',
                         password: p_user, password_confirmation: p_user, status: User::STATUS_ACTIVE)
  user.save!
end
role = Role.givable.detect { |r| r.allowed_to?(:add_issues) && r.allowed_to?(:edit_issues) }
raise 'No issue role' unless role
Member.create!(project: project, user: user, roles: [role]) unless user.member_of?(project)
Setting.mail_from = 'redmine@example.invalid'
Setting.host_name = '127.0.0.1:18881'
Setting.notified_events = ['issue_status_updated']
observer = User.find_or_initialize_by(login: 'signal-mail-observer')
if observer.new_record?
  pass = SecureRandom.hex(32) + '1aA'
  observer.assign_attributes(firstname: 'Demo', lastname: 'Reviewer', mail: 'reviewer@example.invalid',
                             password: pass, password_confirmation: pass, status: User::STATUS_ACTIVE,
                             mail_notification: 'all')
  observer.save!
end
review_role = Role.givable.detect { |r| r.allowed_to?(:view_issues) && !r.allowed_to?(:manage_members) } || role
Member.create!(project: project, user: observer, roles: [review_role]) unless observer.member_of?(project)
puts 'BRIDGE_KEY=' + user.api_key
'''
    result = subprocess.run(compose+['exec','-T','redmine','rails','runner','-'],input=script,text=True,
                            encoding='utf-8',capture_output=True)
    keys = [s[11:] for s in result.stdout.splitlines() if s.startswith('BRIDGE_KEY=')]
    if result.returncode or len(keys)!=1:
        safe = [s for s in result.stderr.splitlines() if 'Error' in s or 'Invalid' in s]
        raise ValueError('Настройка Redmine не завершилась. '+(safe[0].split('\n')[0][:240] if safe else 'Проверьте журнал контейнера.'))
    save({**addresses,'REDMINE_API_KEY':keys[0]})
    print('Готов закрытый проект http://127.0.0.1:18881/projects/signal-demo')


if __name__=='__main__':
    try:
        if '--show-login' in sys.argv:
            print('Пользователь signal-demo\nПароль:',saved()['DEMO_PASSWORD'])
        else:
            setup()
    except (ValueError,OSError,subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
