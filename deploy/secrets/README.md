# Local Podman Compose secrets

Create these files before deploying with `scripts/verify-build-deploy.sh`:

- `session_signing_key` — at least 32 cryptographically random bytes.
- `credential_encryption_key` — a 32-byte encryption key in the encoding required by the backend implementation.
- `bootstrap_admin_password` — the initial Admin password, at least 12 characters.

The secret files are mounted into the backend under `/run/secrets`. Never commit their contents.
