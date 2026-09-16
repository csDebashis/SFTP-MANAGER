"""Deliberately reset the durable demo database and private Blob file prefix."""

from __future__ import annotations

import argparse
import asyncio
import os

from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.db import Database, is_postgresql_url
from app.models import Base
from app.sftp.blob_storage import VercelBlobMockStorage


CONFIRMATION = "RESET-SFTP-MANAGER-DEMO"
POSTGRES_SCHEMA_LOCK = 23443827721299794


async def reset_demo_state() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    deployment_mode = os.getenv("DEPLOYMENT_MODE", "").strip().lower()
    blob_token = os.getenv("BLOB_READ_WRITE_TOKEN", "").strip()
    blob_prefix = os.getenv("BLOB_SFTP_PREFIX", "sftp-manager-demo")
    if deployment_mode != "demo":
        raise RuntimeError("Refusing reset unless DEPLOYMENT_MODE=demo")
    if not is_postgresql_url(database_url):
        raise RuntimeError("Refusing reset unless DATABASE_URL selects PostgreSQL")
    if not blob_token:
        raise RuntimeError("Refusing reset without BLOB_READ_WRITE_TOKEN")

    parsed = make_url(database_url)
    print(f"Resetting demo database {parsed.database!r} on host {parsed.host!r}")
    database = Database(database_url)
    try:
        async with database.engine.begin() as connection:
            await connection.execute(
                text("SELECT pg_advisory_xact_lock(:lock_id)"),
                {"lock_id": POSTGRES_SCHEMA_LOCK},
            )
            await connection.run_sync(Base.metadata.drop_all)
        await database.initialize()
    finally:
        await database.close()

    storage = VercelBlobMockStorage(blob_token, blob_prefix)
    try:
        await storage.clear()
    finally:
        await storage.close()
    print(f"Fresh schema created and Blob prefix {blob_prefix!r} cleared")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", required=True, help=f"must equal {CONFIRMATION}")
    args = parser.parse_args()
    if args.confirm != CONFIRMATION:
        raise SystemExit(f"Refusing reset: --confirm must equal {CONFIRMATION}")
    asyncio.run(reset_demo_state())


if __name__ == "__main__":
    main()
