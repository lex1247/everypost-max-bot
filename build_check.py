"""Render build: verify in a clean test environment before touching live state."""
import os
import subprocess
import sys


def test_environment():
    # Unit tests must not inherit live bot tokens, destinations, LLM choices or database URLs.
    keep={'PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','PYTHONPATH',
          'LD_LIBRARY_PATH','DYLD_LIBRARY_PATH','SYSTEMROOT','SSL_CERT_FILE','SSL_CERT_DIR'}
    return {key:value for key,value in os.environ.items() if key in keep}


def main():
    subprocess.run([sys.executable,'-m','pip','install','-r','requirements.txt','pgserver==0.1.4'],check=True)
    subprocess.run([sys.executable,'-m','unittest','discover','-p','test_*.py','-q'],check=True,env=test_environment())
    subprocess.run([sys.executable,'postgres_selftest.py'],check=True,env=test_environment())


if __name__=='__main__':main()
