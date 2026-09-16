"""Read-only checks for the target machine, before live traffic is switched."""
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
from monitor import env_file

ROOT = Path(__file__).resolve().parent


def main():
    domains = env_file(ROOT/'config/domains.env')
    expected = env_file(ROOT/'.env').get('EP_RUN_MODE','standby')
    for service, domain in [('max',domains['MAX_DOMAIN']),('telegram',domains['TG_DOMAIN'])]:
        with urllib.request.urlopen('https://'+domain+'/health',timeout=15) as response:
            data=json.load(response)
        if not data.get('ok') or data.get('mode') != expected:
            raise RuntimeError(service+' readiness failed')
        print(service+': HTTPS and database available, mode='+expected)
    if expected != 'standby':
        return
    for service,domain,path in [('max',domains['MAX_DOMAIN'],'/webhook'),
                                ('telegram',domains['TG_DOMAIN'],'/telegram/webhook')]:
        try:
            urllib.request.urlopen(urllib.request.Request('https://'+domain+path,
                data=b'{}',headers={'Content-Type':'application/json'}),timeout=15)
        except urllib.error.HTTPError as error:
            if error.code == 503:
                print(service+': incoming jobs blocked in standby')
                continue
            raise
        raise RuntimeError(service+' accepted a standby write')
    # Uses a configured seed privately from the DB; only prints a result, no token or media URL.
    code = """
import asyncio, os
import psycopg
from content_source import inspect
with psycopg.connect(os.environ['DATABASE_URL']) as db:
    row=db.execute('SELECT canonical_url FROM public.ep_content_candidates ORDER BY id LIMIT 1').fetchone()
if not row: raise SystemExit('No saved seed video')
data=asyncio.run(inspect(row[0]))
assert data.get('content_hash') and data.get('fingerprint')
print('TikTok: download and video fingerprint passed')
"""
    result=subprocess.run(['docker','compose','exec','-T','telegram','python','-c',code],
                           cwd=ROOT,capture_output=True,text=True,timeout=210)
    if result.returncode:
        raise RuntimeError('TikTok check failed on this server. Do not activate.')
    print(result.stdout.strip())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Preflight failed: '+type(error).__name__+'; leave target in standby.',file=sys.stderr)
        sys.exit(1)
