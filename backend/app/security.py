"""
Authentication and role-based access control for Bog'chaOS.

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions are HMAC-signed,
expiring tokens carrying the user's id, role and organisation. Every API route
declares the permission it needs; PERMISSIONS below is the single source of truth
that the frontend also receives through /auth/me.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import Depends, Header, HTTPException

PBKDF2_ITERATIONS = 240_000
HASH_PREFIX = "pbkdf2_sha256"
TOKEN_TTL_SECONDS = 12 * 60 * 60

_SECRET_FILE = Path(__file__).resolve().parent.parent / ".secret_key"


def _load_secret() -> bytes:
    env = os.getenv("BOGCHA_SECRET_KEY")
    if env:
        return env.encode()
    if not _SECRET_FILE.exists():
        _SECRET_FILE.write_text(secrets.token_hex(32), encoding="utf-8")
    return _SECRET_FILE.read_text(encoding="utf-8").strip().encode()


SECRET_KEY = _load_secret()

ALL_STAFF = {"super_admin", "director", "accountant", "teacher", "nurse"}
MANAGEMENT = {"super_admin", "director"}
FINANCE = {"super_admin", "director", "accountant"}

PERMISSIONS: dict[str, set[str]] = {
    "dashboard.view": FINANCE,
    "children.view": ALL_STAFF,
    "children.create": FINANCE,
    "children.delete": MANAGEMENT | {"accountant"},
    "children.finance": FINANCE,
    "children.health.edit": MANAGEMENT | {"nurse"},
    "children.pricing.edit": FINANCE,
    "parents.invite": MANAGEMENT | {"teacher"},
    "photos.send": MANAGEMENT | {"teacher"},
    "telegram.group.manage": MANAGEMENT,
    "kitchen.view": MANAGEMENT | {"accountant", "nurse"},
    "kitchen.manage": {"super_admin", "accountant"},
    "groups.manage": MANAGEMENT,
    "groups.delete": {"super_admin"},
    "attendance.view": ALL_STAFF,
    "attendance.mark": MANAGEMENT | {"teacher", "accountant"},
    "tabel.view": FINANCE,
    "billing.view": FINANCE,
    "billing.record": FINANCE,
    "billing.remind": FINANCE,
    "finance.reports": {"super_admin", "accountant"},
    "staff.view": FINANCE,
    "staff.pay": FINANCE,
    "staff.manage": {"super_admin", "accountant"},
    "staff.attendance.mark": FINANCE,
    "contracts.view": MANAGEMENT,
    "tma.view": {"super_admin"},
    "settings.view": MANAGEMENT,
    "settings.manage": MANAGEMENT,
    "audit.view": MANAGEMENT,
}


def permissions_for(role: str) -> list[str]:
    return sorted(p for p, roles in PERMISSIONS.items() if role in roles)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return f"{HASH_PREFIX}${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def is_hashed(stored: str) -> bool:
    return stored.startswith(HASH_PREFIX + "$")


def verify_password(password: str, stored: str) -> bool:
    if not is_hashed(stored):
        return False
    _, iterations, salt, expected = stored.split("$", 3)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
    return hmac.compare_digest(digest.hex(), expected)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(user_id: str, role: str, org_id: str) -> str:
    payload = {"sub": user_id, "role": role, "org": org_id, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(SECRET_KEY, body.encode(), hashlib.sha256).digest())
    return f"{body}.{signature}"


def decode_token(token: str) -> dict:
    try:
        body, signature = token.split(".", 1)
    except ValueError:
        raise HTTPException(status_code=401, detail="Sessiya yaroqsiz. Qayta kiring.")
    expected = _b64(hmac.new(SECRET_KEY, body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Sessiya yaroqsiz. Qayta kiring.")
    payload = json.loads(_unb64(body))
    if payload.get("exp", 0) < time.time():
        raise HTTPException(status_code=401, detail="Sessiya muddati tugadi. Qayta kiring.")
    return payload


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Tizimga kirilmagan.")
    payload = decode_token(authorization.split(" ", 1)[1].strip())

    from app.database import get_connection
    conn = get_connection()
    row = conn.execute(
        "SELECT id, role, org_id, full_name, phone, avatar FROM users WHERE id = ? AND is_active = 1",
        (payload["sub"],),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Foydalanuvchi faol emas.")
    role = row["role"].lower()
    return {
        "id": row["id"],
        "role": role,
        "org": row["org_id"],
        "name": row["full_name"],
        "phone": row["phone"],
        "avatar": row["avatar"],
        "permissions": set(permissions_for(role)),
    }


def require(permission: str):
    if permission not in PERMISSIONS:
        raise ValueError(f"Unknown permission: {permission}")

    def dependency(user: dict = Depends(current_user)) -> dict:
        if permission not in user["permissions"]:
            raise HTTPException(status_code=403, detail="Bu amal uchun ruxsatingiz yo'q.")
        return user

    return dependency
