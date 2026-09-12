"""Password, session-token, and credential-encryption primitives.

The helpers return hashes or ciphertext only. Callers must never log inputs,
derived keys, plaintext credentials, reset tokens, or session identifiers.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from argon2 import PasswordHasher
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


password_hasher = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=2)


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except Exception:
        return False


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_session_tokens() -> tuple[str, str, datetime]:
    return (
        secrets.token_urlsafe(48),
        secrets.token_urlsafe(32),
        datetime.now(timezone.utc) + timedelta(hours=8),
    )


def _encryption_key() -> bytes:
    key_file = os.getenv("APP_CREDENTIAL_ENCRYPTION_KEY_FILE")
    if key_file and Path(key_file).is_file():
        raw = Path(key_file).read_bytes().strip()
        try:
            decoded = base64.urlsafe_b64decode(raw)
            if len(decoded) == 32:
                return decoded
        except Exception:
            pass
        if len(raw) == 32:
            return raw
        raise ValueError("credential encryption key must contain 32 bytes or urlsafe base64")
    if os.getenv("APP_ENV", "development") == "production":
        raise ValueError("APP_CREDENTIAL_ENCRYPTION_KEY_FILE is required in production")
    return hashlib.sha256(b"sftp-manager-development-only-key").digest()


def encrypt_credential(data: dict[str, Any]) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(_encryption_key()).encrypt(nonce, json.dumps(data).encode("utf-8"), None)
    return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_credential(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    raw = base64.urlsafe_b64decode(value.encode("ascii"))
    plaintext = AESGCM(_encryption_key()).decrypt(raw[:12], raw[12:], None)
    return json.loads(plaintext.decode("utf-8"))
