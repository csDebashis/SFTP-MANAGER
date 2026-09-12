# Local Compose secrets

Create these files before deploying with `scripts/verify-build-deploy.sh`:

- `session_signing_key` — at least 32 cryptographically random bytes.
- `credential_encryption_key` — a 32-byte encryption key in the encoding required by the backend implementation.
- `bootstrap_admin_password` — the initial Admin password, at least 12 characters.

The secret files are mounted into the backend under `/run/secrets`. Never commit their contents.

Vercel cannot mount these files. For a Vercel PostgreSQL deployment, store the
equivalent bootstrap secret as `BOOTSTRAP_ADMIN_PASSWORD` and the encryption
secret as `APP_CREDENTIAL_ENCRYPTION_KEY` in the project's encrypted Production
environment variables. Do not upload or commit the files. The current Vercel
session tokens are random opaque values stored as hashes in PostgreSQL and do
not use the Compose session-signing file.
