from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import asyncssh
import pytest

from app.models import SftpServer
from app.sftp.gateway import SftpGateway


@pytest.mark.asyncio
async def test_real_sftp_listing_consumes_async_scandir_iterator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scanned_paths: list[str] = []

    async def entries():  # type: ignore[no-untyped-def]
        yield SimpleNamespace(
            filename=".",
            attrs=SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY, size=None, mtime=1_725_000_000),
        )
        yield SimpleNamespace(
            filename="..",
            attrs=SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY, size=None, mtime=1_725_000_000),
        )
        yield SimpleNamespace(
            filename="incoming",
            attrs=SimpleNamespace(type=asyncssh.FILEXFER_TYPE_DIRECTORY, size=None, mtime=1_725_000_000),
        )
        yield SimpleNamespace(
            filename="report.csv",
            attrs=SimpleNamespace(type=asyncssh.FILEXFER_TYPE_REGULAR, size=128, mtime=1_725_000_100),
        )

    def scandir(remote_path: str):  # type: ignore[no-untyped-def]
        scanned_paths.append(remote_path)
        return entries()

    sftp_client = SimpleNamespace(scandir=scandir)
    connection = SimpleNamespace(
        start_sftp_client=AsyncMock(return_value=sftp_client),
        close=Mock(),
        wait_closed=AsyncMock(),
    )
    gateway = SftpGateway(tmp_path / "mock-sftp")
    monkeypatch.setattr(gateway, "_connect", AsyncMock(return_value=connection))
    server = SftpServer(
        name="Real SFTP",
        host="sftp.example.com",
        port=22,
        username="test-user",
        auth_type="PASSWORD",
        root_path="/remote/root",
        host_key_fingerprint="SHA256:test",
        adapter_type="REAL",
        enabled=True,
    )

    items = await gateway.list(server, "/")

    assert scanned_paths == ["/remote/root/"]
    assert items == [
        {"name": "incoming", "path": "/incoming", "type": "folder", "size": 0, "modifiedAt": 1_725_000_000},
        {"name": "report.csv", "path": "/report.csv", "type": "file", "size": 128, "modifiedAt": 1_725_000_100},
    ]
    connection.close.assert_called_once_with()
    connection.wait_closed.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_real_chunk_progress_returns_only_remote_stat_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = SimpleNamespace(seek=AsyncMock(return_value=0), write=AsyncMock(return_value=5))
    output_context = AsyncMock()
    output_context.__aenter__.return_value = output
    sftp_client = SimpleNamespace(
        stat=AsyncMock(side_effect=[SimpleNamespace(size=0), SimpleNamespace(size=5)]),
        open=Mock(return_value=output_context),
    )
    connection = SimpleNamespace(
        start_sftp_client=AsyncMock(return_value=sftp_client),
        close=Mock(),
        wait_closed=AsyncMock(),
    )
    gateway = SftpGateway(tmp_path / "mock-sftp")
    monkeypatch.setattr(gateway, "_connect", AsyncMock(return_value=connection))
    server = SftpServer(
        name="Real SFTP",
        host="sftp.example.com",
        port=22,
        username="test-user",
        auth_type="PASSWORD",
        root_path="/remote/root",
        host_key_fingerprint="SHA256:test",
        adapter_type="REAL",
        enabled=True,
    )
    async def chunks():  # type: ignore[no-untyped-def]
        yield b"hello"

    received = await gateway.write_upload_chunk(
        server,
        "/incoming/report.bin",
        "12345678-1234-1234-1234-123456789abc",
        0,
        chunks(),
    )

    assert received == 5
    output.seek.assert_awaited_once_with(0)
    output.write.assert_awaited_once_with(b"hello")
    assert sftp_client.stat.await_count == 2
    connection.close.assert_called_once_with()
    connection.wait_closed.assert_awaited_once_with()
