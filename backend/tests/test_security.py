"""Security-secret loading tests shared by container and serverless runtimes."""

from __future__ import annotations

import base64

from app.security import decrypt_credential, encrypt_credential


def test_credential_encryption_accepts_serverless_environment_secret(monkeypatch) -> None:
    key = base64.urlsafe_b64encode(b"sftp-manager-vercel-key-32-byte!").decode("ascii")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_CREDENTIAL_ENCRYPTION_KEY", key)
    monkeypatch.delenv("APP_CREDENTIAL_ENCRYPTION_KEY_FILE", raising=False)

    encrypted = encrypt_credential({"password": "not-logged"})

    assert decrypt_credential(encrypted) == {"password": "not-logged"}
    assert "not-logged" not in encrypted
