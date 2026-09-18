"""Create local private configuration; never print or overwrite credentials."""
import os
import secrets
from pathlib import Path


def configure(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(folder, 0o700)
    if any(folder.iterdir()):
        raise SystemExit('Configuration already exists; nothing overwritten.')
    password = secrets.token_hex(32)
    database = f'postgresql://everypost:{password}@db:5432/everypost'
    values = {
        'db.env': f'POSTGRES_USER=everypost\nPOSTGRES_DB=everypost\nPOSTGRES_PASSWORD={password}\n',
        'max.env': f'DATABASE_URL={database}\nMAX_BOT_TOKEN=\nPUBLIC_URL=\nBRIDGE_URL=\nSUBSCRIPTION_ADMIN_MAX_ID=\n',
        'telegram.env': f'DATABASE_URL={database}\nTG_BOT_TOKEN=\nMAX_BOT_TOKEN=\nOWNER_ID=\nPUBLIC_URL=\nEXPECTED_TG_BOT_USERNAME=EveryPost_bot\nFREE_TEST_MODE=1\nLLM_PROVIDER=llm7\nLLM7_APPROVED=1\nLLM7_MODEL=minimax-m2.7\nPOLL_SECONDS=30\nREQUIRE_MIGRATION=1\n',
        'domains.env': 'MAX_DOMAIN=\nTG_DOMAIN=\n',
        'backup.env': f'RESTIC_REPOSITORY=\nAWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nRESTIC_PASSWORD={secrets.token_hex(32)}\n',
    }
    for name, value in values.items():
        with (folder/name).open('x') as target:
            target.write(value)
        os.chmod(folder/name, 0o600)
    print('Private templates created. Fill credentials on the server; no credentials printed.')


if __name__ == '__main__':
    os.umask(0o077)
    configure(Path(__file__).parent/'config')
