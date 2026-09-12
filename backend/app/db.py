"""Async SQLAlchemy lifecycle and current-baseline schema initialization."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import event, inspect, select
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql.schema import MetaData

from .models import Base, CURRENT_SCHEMA_BASELINE, SchemaBaseline


class SchemaBaselineError(RuntimeError):
    """Raised when a database does not match this application's baseline."""


def _validate_schema(metadata: MetaData, connection: Connection) -> None:
    """Compare persistent tables and columns with the declared baseline.

    This application intentionally has no migration framework. A database is
    either empty and initialized from the current SQLAlchemy metadata or must
    already match that metadata exactly. This prevents ``create_all`` from
    silently accepting an older database whose existing tables lack columns.
    """

    inspector = inspect(connection)
    expected_tables = set(metadata.tables)
    actual_tables = set(inspector.get_table_names())
    if actual_tables != expected_tables:
        missing = sorted(expected_tables - actual_tables)
        unexpected = sorted(actual_tables - expected_tables)
        raise SchemaBaselineError(
            f"SQLite schema does not match baseline {CURRENT_SCHEMA_BASELINE}; "
            f"missing tables={missing}, unexpected tables={unexpected}"
        )

    for table_name, table in metadata.tables.items():
        expected_columns = set(table.columns.keys())
        actual_columns = {column["name"] for column in inspector.get_columns(table_name)}
        if actual_columns != expected_columns:
            missing = sorted(expected_columns - actual_columns)
            unexpected = sorted(actual_columns - expected_columns)
            raise SchemaBaselineError(
                f"SQLite table {table_name!r} does not match baseline "
                f"{CURRENT_SCHEMA_BASELINE}; missing columns={missing}, "
                f"unexpected columns={unexpected}"
            )


class Database:
    """Own the async engine and short-lived request session factory."""

    def __init__(self, url: str):
        self.url = url
        self.engine = create_async_engine(url, pool_pre_ping=True)

        @event.listens_for(self.engine.sync_engine, "connect")
        def configure_sqlite(dbapi_connection, _connection_record):  # type: ignore[no-untyped-def]
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=FULL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def initialize(self) -> None:
        """Create an empty baseline database or validate an existing one."""

        async with self.engine.begin() as connection:
            table_names = await connection.run_sync(
                lambda sync_connection: inspect(sync_connection).get_table_names()
            )
            if not table_names:
                await connection.run_sync(Base.metadata.create_all)
                await connection.execute(
                    SchemaBaseline.__table__.insert().values(
                        id=1,
                        version=CURRENT_SCHEMA_BASELINE,
                    )
                )
            await connection.run_sync(lambda sync_connection: _validate_schema(Base.metadata, sync_connection))
            baseline = await connection.scalar(
                select(SchemaBaseline.version).where(SchemaBaseline.id == 1)
            )
            if baseline != CURRENT_SCHEMA_BASELINE:
                raise SchemaBaselineError(
                    f"SQLite schema baseline {baseline!r} is incompatible; "
                    f"expected {CURRENT_SCHEMA_BASELINE!r}"
                )

    async def close(self) -> None:
        await self.engine.dispose()

    async def session(self) -> AsyncIterator[AsyncSession]:
        """Yield one unit-of-work session without committing implicitly."""

        async with self.sessions() as session:
            yield session
