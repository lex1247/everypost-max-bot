"""MAX's CA trust is scoped to its own HTTP client, never the system or other APIs."""
from pathlib import Path
import ssl
import certifi


def max_ssl_context():
    # Python on macOS can have an empty default CA store. Match httpx's standard
    # public roots for MAX's upload host before adding the MAX API root.
    context = ssl.create_default_context(cafile=certifi.where())
    root = Path(__file__).parent
    certificate = root / 'certs/russian-trusted-root.pem'
    if not certificate.exists():
        certificate = root / 'russian-trusted-root.pem'
    context.load_verify_locations(cafile=str(certificate))
    return context
