"""Async SQLAlchemy lifecycle and current-baseline schema initialization."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import event, inspect, select, text
from sqlalchemy.engine import Connection, URL, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql.schema import MetaData

from .models import Base, CURRENT_SCHEMA_BASELINE, SchemaBaseline


class SchemaBaselineError(RuntimeError):
    """Raised when a database does not match this application's baseline."""


def prepare_database_url(raw_url: str) -> tuple[URL, dict[str, str]]:
    """Select an async driver and safe connection arguments for SQLAlchemy."""

    url = make_url(raw_url)
    connect_args: dict[str, str] = {}
    if url.get_backend_name() == "postgresql":
        url = url.set(drivername="postgresql+asyncpg")
        query = dict(url.query)
        ssl_mode = query.pop("sslmode", None)
        # asyncpg does not implement libpq channel binding. TLS remains
        # mandatory through the provider's sslmode value.
        query.pop("channel_binding", None)
        url = url.set(query=query)
        if ssl_mode:
            connect_args["ssl"] = str(ssl_mode)
    return url, connect_args


def is_postgresql_url(raw_url: str | None) -> bool:
    """Return whether a configured URL selects PostgreSQL without leaking it."""

    if not raw_url:
        return False
    try:
        return make_url(raw_url).get_backend_name() == "postgresql"
    except Exception:
        return False


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
            f"Database schema does not match baseline {CURRENT_SCHEMA_BASELINE}; "
            f"missing tables={missing}, unexpected tables={unexpected}"
        )

    for table_name, table in metadata.tables.items():
        expected_columns = set(table.columns.keys())
        actual_columns = {column["name"] for column in inspector.get_columns(table_name)}
        if actual_columns != expected_columns:
            missing = sorted(expected_columns - actual_columns)
            unexpected = sorted(actual_columns - expected_columns)
            raise SchemaBaselineError(
                f"Database table {table_name!r} does not match baseline "
                f"{CURRENT_SCHEMA_BASELINE}; missing columns={missing}, "
                f"unexpected columns={unexpected}"
            )


class Database:
    """Own the async engine and short-lived request session factory."""

    def __init__(self, url: str):
        prepared_url, connect_args = prepare_database_url(url)
        self.url = prepared_url.render_as_string(hide_password=False)
        self.dialect = prepared_url.get_backend_name()
        engine_options: dict[str, object] = {
            "pool_pre_ping": True,
            "connect_args": connect_args,
        }
        if self.dialect == "postgresql":
            # Keep each serverless instance's local pool deliberately small;
            # the Neon URL itself uses its provider-managed PgBouncer pool.
            engine_options.update(pool_size=1, max_overflow=2, pool_recycle=300)
        self.engine = create_async_engine(prepared_url, **engine_options)

        if self.dialect == "sqlite":
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
            if self.dialect == "postgresql":
                # Concurrent cold starts must not race while creating or
                # validating the shared schema.
                await connection.execute(
                    text("SELECT pg_advisory_xact_lock(:lock_id)"),
                    {"lock_id": 23443827721299794},
                )
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
