"""Vercel entrypoint: runs the FastAPI backend, which also serves the dashboard."""
import os
import shutil
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "backend"))

# The deployment's filesystem is read-only except /tmp, so the SQLite database
# lives there. A fresh instance starts from deploy_data/bogcha_data.db when one
# is uploaded with the deployment (never committed), otherwise from seed data.
DB_PATH = os.environ.setdefault("BOGCHA_DB_PATH", "/tmp/bogcha_data.db")
BUNDLED_DB = os.path.join(ROOT, "deploy_data", "bogcha_data.db")
if os.path.exists(BUNDLED_DB) and not os.path.exists(DB_PATH):
    shutil.copyfile(BUNDLED_DB, DB_PATH)

from app.database import init_db  # noqa: E402
from app.main import app  # noqa: E402,F401
from app.security import hash_password  # noqa: E402

# Serverless instances may not run the ASGI lifespan, so create tables here.
init_db()


def _ensure_env_admin():
    """Seeding skips an existing database, so add the env super admin here too."""
    phone, password = os.getenv("BOGCHA_ADMIN_PHONE"), os.getenv("BOGCHA_ADMIN_PASSWORD")
    if not (phone and password):
        return
    conn = sqlite3.connect(DB_PATH)
    try:
        if conn.execute("SELECT 1 FROM users WHERE phone = ?", (phone,)).fetchone():
            return
        org = conn.execute("SELECT id FROM organizations ORDER BY created_at LIMIT 1").fetchone()
        if not org:
            return
        conn.execute(
            "INSERT INTO users (id, org_id, role, full_name, phone, password_hash, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("u_admin_env", org[0], "SUPER_ADMIN", "Super Admin", phone, hash_password(password), "SA"),
        )
        conn.commit()
    finally:
        conn.close()


_ensure_env_admin()
