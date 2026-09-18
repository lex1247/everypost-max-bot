"""Assemble the two existing repository branches into one immutable release."""
import argparse
import json
from pathlib import Path
import subprocess


def git(*args):
    return subprocess.check_output(['git',*args])


def assemble(max_ref, telegram_ref, output):
    output=Path(output)
    if output.exists():
        raise SystemExit('Destination already exists; refusing to overwrite a release.')
    refs={key:git('rev-parse','--verify',ref+'^{commit}').decode().strip()
          for key,ref in [('max',max_ref),('telegram',telegram_ref)]}
    output.mkdir(parents=True)
    for service,ref in refs.items():
        paths=git('ls-tree','-r','--name-only',ref).decode().splitlines()
        for path in paths:
            if service=='max':
                include=path in ('index.js','package.json','package-lock.json','runtime-tests.mjs') or path.startswith('deploy/')
                target=output/path if path.startswith('deploy/') else output/'max'/path
            else:
                include=('/' not in path and (path.endswith(('.py','.pem','.html')) or path=='requirements.txt'))
                target=output/'telegram'/path
            if include:
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(git('show',ref+':'+path))
    (output/'release.json').write_text(json.dumps(refs,indent=2)+'\n')
    print('Release assembled at '+str(output.resolve()))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--max-ref',required=True)
    parser.add_argument('--telegram-ref',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    assemble(args.max_ref,args.telegram_ref,args.output)
