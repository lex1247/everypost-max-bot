"""Host-side probe. Restart hung running workers; never resume a stopped service."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
QUEUE_SQL = """
SELECT count(*) FROM public.ep_schedules
 WHERE status='scheduled' AND due_at < NOW()-INTERVAL '5 minutes' AND next_at<=NOW();
SELECT count(*) FROM public.ep_schedules WHERE status='needs_check';
SELECT count(*) FROM repost_bot.ed_posts
 WHERE state='scheduled' AND publish_at < EXTRACT(EPOCH FROM NOW())-300;
SELECT count(*) FROM repost_bot.deliveries WHERE status IN ('unknown','failed','review','unavailable');
"""
QUEUE_LABELS = ('MAX: overdue posts', 'MAX: delivery needs review',
                'Telegram: overdue posts', 'Telegram: delivery needs review')


def env_file(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def command(args, *, input=None):
    result = subprocess.run(args, cwd=ROOT, input=input, text=True,
                            capture_output=True, timeout=100)
    if result.returncode:
        # Docker/psql output may contain configuration or private post text.
        raise RuntimeError('Operational command failed')
    return result.stdout.strip()


def restart_allowed(service, health, running, history, now):
    recent = [stamp for stamp in history if now-stamp < 3600]
    allowed = (service in ('max','telegram') and running and health == 'unhealthy'
               and len(recent) < 3 and (not recent or now-recent[-1] >= 300))
    return allowed, recent


def notify_owner(message):
    config = env_file(ROOT/'config/telegram.env')
    token, owner = config.get('TG_BOT_TOKEN'), config.get('OWNER_ID')
    if not token or not owner:
        return False
    data = json.dumps({'chat_id':owner,'text':message}).encode()
    request = urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',
                                     data=data,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=15) as response:
            return bool(json.load(response).get('ok'))
    except Exception:
        print('Owner notification could not be delivered.',flush=True)
        return False


def inspect_service(service):
    identifier = command(['docker','compose','ps','--all','--quiet',service])
    if not identifier or '\n' in identifier:
        return False, 'missing'
    state = json.loads(command(['docker','inspect','--format','{{json .State}}',identifier]))
    return state.get('Running',False), state.get('Health',{}).get('Status',state.get('Status','missing'))


def check(state, now):
    problems = []
    for service in ('db','max','telegram','edge'):
        try:
            running, health = inspect_service(service)
            history = state.setdefault('restarts',{}).get(service,[])
            restart, recent = restart_allowed(service,health,running,history,now)
            if restart:
                command(['docker','compose','restart','--no-deps',service])
                recent.append(now)
            state['restarts'][service] = recent
            if not running or health == 'unhealthy':
                problems.append(service+': '+health)
        except Exception:
            problems.append(service+': probe failed')
    try:
        # Read-only, does not retry publication of any ambiguous sends.
        counts = command(['docker','compose','exec','-T','db','sh','-c',
            'exec psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],input=QUEUE_SQL).splitlines()
        if len(counts)!=len(QUEUE_LABELS) or any(not c.isdigit() for c in counts):
            raise ValueError('Unexpected probe result')
        problems += [QUEUE_LABELS[i] for i,c in enumerate(counts) if int(c)>0]
    except Exception:
        problems.append('Queue status unavailable')
    backup = ROOT/'state/backup-success'
    try:
        if now-float(backup.read_text()) > 7*3600:
            problems.append('Off-server backup older than 7 hours')
    except (OSError,ValueError):
        problems.append('No confirmed off-server backup')
    disk = shutil.disk_usage(ROOT)
    if disk.used/disk.total > 0.85:
        problems.append('Server disk usage above 85%')
    return sorted(problems)


def main():
    os.umask(0o077)
    os.chdir(ROOT)
    # Standby is a deliberate non-publishing test, not an outage.
    if env_file(ROOT/'.env').get('EP_RUN_MODE','standby') != 'active':
        return
    state_dir = ROOT/'state'
    state_dir.mkdir(exist_ok=True)
    with (state_dir/'monitor.lock').open('w') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_file = state_dir/'monitor.json'
        try:
            state = json.loads(state_file.read_text())
        except (OSError,ValueError):
            state = {}
        problems = check(state,time.time())
        previous = state.get('notified',[])
        if problems != previous:
            message = ('EveryPost: требуется проверка.\n'+'\n'.join(problems) if problems else
                       'EveryPost: проверка сервера снова проходит. Очередь доступна.')
            if notify_owner(message):
                state['notified'] = problems
        state['checked_at'] = time.time()
        state['problems'] = problems
        temp = state_file.with_suffix('.tmp')
        temp.write_text(json.dumps(state))
        temp.replace(state_file)
        print('EveryPost: '+('healthy' if not problems else '; '.join(problems)),flush=True)


if __name__ == '__main__':
    main()
