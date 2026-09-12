"""Render build: install dependencies and verify before touching the live database."""
import subprocess
import sys

subprocess.run([sys.executable,'-m','pip','install','-r','requirements.txt','pgserver==0.1.4'],check=True)
subprocess.run([sys.executable,'-m','unittest','discover','-p','test_*.py','-q'],check=True)
subprocess.run([sys.executable,'postgres_selftest.py'],check=True)
