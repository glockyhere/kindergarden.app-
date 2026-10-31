"""Vercel entrypoint: runs the FastAPI backend, which also serves the dashboard."""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "backend"))

# The deployment's filesystem is read-only except /tmp, so the SQLite database
# lives there and is rebuilt from seed data whenever a fresh instance starts.
os.environ.setdefault("BOGCHA_DB_PATH", "/tmp/bogcha_data.db")

from app.database import init_db  # noqa: E402
from app.main import app  # noqa: E402,F401

# Serverless instances may not run the ASGI lifespan, so create tables here.
init_db()
