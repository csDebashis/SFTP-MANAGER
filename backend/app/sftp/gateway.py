"""SFTP boundary with pinned host keys, safe paths, and resumable transfers.

The gateway is the only application component that translates logical portal
paths into remote paths. Both real and deterministic mock adapters follow the
same traversal and symlink restrictions.
"""

from __future__ import annotations

import asyncio
import os
import posixpath
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import asyncssh

from ..models import SftpServer
from ..security import decrypt_credential


def canonical_path(path: str) -> str:
    if not path or not path.startswith("/") or "\\" in path or "\x00" in path:
        raise ValueError("invalid absolute POSIX path")
    if any(part == ".." for part in path.split("/")):
        raise ValueError("path traversal is not allowed")
    normalized = posixpath.normpath(path)
    if len(normalized.encode("utf-8")) > 1024:
        raise ValueError("path is too long")
    return normalized if normalized.startswith("/") else f"/{normalized}"


def valid_name(name: str) -> str:
    if not name or name in {".", ".."} or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("invalid file name")
    if len(name.encode("utf-8")) > 255:
        raise ValueError("file name is too long")
    return name


class _PinnedHostKeyClient(asyncssh.SSHClient):
    """Validate the host key during the SSH handshake, before authentication."""

    def __init__(self, expected_fingerprint: str, allow_unpinned: bool = False):
        self.expected_fingerprint = expected_fingerprint
        self.allow_unpinned = allow_unpinned
        self.observed_fingerprint = ""

    def validate_host_public_key(self, host: str, addr: str, port: int, key: asyncssh.SSHKey) -> bool:
        self.observed_fingerprint = key.get_fingerprint("sha256")
        return self.allow_unpinned or bool(self.expected_fingerprint) and self.observed_fingerprint == self.expected_fingerprint


class SftpGateway:
    """Execute bounded SFTP operations without exposing credentials upstream."""

    def __init__(self, mock_root: Path):
        self.mock_root = mock_root.resolve()
        self.mock_root.mkdir(parents=True, exist_ok=True)

    def _mock_path(self, path: str) -> Path:
        path = canonical_path(path)
        target = (self.mock_root / path.lstrip("/")).resolve()
        if target != self.mock_root and self.mock_root not in target.parents:
            raise ValueError("path escapes mock root")
        if target.is_symlink():
            raise ValueError("symbolic links are not supported")
        return target

    @staticmethod
    def _upload_temp_path(target_path: str, upload_id: str) -> str:
        target_path = canonical_path(target_path)
        if not upload_id or any(character not in "0123456789abcdef-" for character in upload_id.lower()):
            raise ValueError("invalid upload identifier")
        return canonical_path(posixpath.join(
            posixpath.dirname(target_path),
            f".{posixpath.basename(target_path)}.uploading-{upload_id}",
        ))

    @staticmethod
    def _remote_path(server: SftpServer, logical_path: str) -> str:
        return posixpath.join(server.root_path, canonical_path(logical_path).lstrip("/"))

    async def test(self, server: SftpServer, *, discover_host_key: bool = False) -> dict[str, Any]:
        if server.adapter_type == "MOCK":
            return {"success": True, "message": "Mock SFTP is ready", "fingerprint": "mock-local"}
        try:
            connection = await self._connect(server, allow_unpinned=discover_host_key)
            try:
                return {
                    "success": True,
                    "message": "Connection successful",
                    "fingerprint": connection.get_server_host_key().get_fingerprint("sha256"),
                }
            finally:
                connection.close()
                await connection.wait_closed()
        except Exception as exc:
            return {"success": False, "message": type(exc).__name__}

    async def _connect(self, server: SftpServer, *, allow_unpinned: bool = False):  # type: ignore[no-untyped-def]
        credential = decrypt_credential(server.encrypted_credential)
        if not server.host_key_fingerprint and not allow_unpinned:
            raise PermissionError("SFTP host key fingerprint is required")
        host_key_client = _PinnedHostKeyClient(server.host_key_fingerprint, allow_unpinned)
        options: dict[str, Any] = {
            "host": server.host,
            "port": server.port,
            "username": server.username,
            "known_hosts": (),
            "client_factory": lambda: host_key_client,
            "server_host_key_algs": "default",
            "connect_timeout": 10,
            "agent_path": None,
        }
        if server.auth_type == "PRIVATE_KEY":
            options["client_keys"] = [asyncssh.import_private_key(credential.get("privateKey", ""), credential.get("passphrase"))]
        else:
            options["password"] = credential.get("password", "")
        connection = await asyncssh.connect(**options)
        return connection

    async def list(self, server: SftpServer, path: str) -> list[dict[str, Any]]:
        path = canonical_path(path)
        if server.adapter_type == "MOCK":
            target = self._mock_path(path)
            if not target.is_dir():
                raise FileNotFoundError(path)
            result = []
            for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
                if child.is_symlink():
                    continue
                stat = child.stat()
                result.append({
                    "name": child.name,
                    "path": canonical_path(posixpath.join(path, child.name)),
                    "type": "folder" if child.is_dir() else "file",
                    "size": stat.st_size,
                    "modifiedAt": stat.st_mtime,
                })
            return result
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            remote = posixpath.join(server.root_path, path.lstrip("/"))
            result = []
            async for entry in client.scandir(remote):
                if entry.filename in {".", ".."} or entry.attrs.type == asyncssh.FILEXFER_TYPE_SYMLINK:
                    continue
                is_dir = entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
                result.append({
                    "name": entry.filename,
                    "path": canonical_path(posixpath.join(path, entry.filename)),
                    "type": "folder" if is_dir else "file",
                    "size": entry.attrs.size or 0,
                    "modifiedAt": entry.attrs.mtime or 0,
                })
            return sorted(result, key=lambda item: (item["type"] != "folder", item["name"].lower()))
        finally:
            connection.close()
            await connection.wait_closed()

    async def begin_upload(
        self,
        server: SftpServer,
        folder: str,
        filename: str,
        upload_id: str,
        *,
        replace: bool = False,
    ) -> str:
        """Create the remote temporary object used by a resumable upload."""
        target_path = canonical_path(posixpath.join(canonical_path(folder), valid_name(filename)))
        temporary_path = self._upload_temp_path(target_path, upload_id)
        if server.adapter_type == "MOCK":
            target = self._mock_path(target_path)
            temporary = self._mock_path(temporary_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and not replace:
                raise FileExistsError(filename)
            temporary.unlink(missing_ok=True)
            temporary.touch(exist_ok=False)
            return target_path

        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            target = self._remote_path(server, target_path)
            temporary = self._remote_path(server, temporary_path)
            if not replace:
                try:
                    await client.stat(target)
                    raise FileExistsError(filename)
                except asyncssh.SFTPNoSuchFile:
                    pass
            try:
                await client.remove(temporary)
            except asyncssh.SFTPNoSuchFile:
                pass
            async with client.open(temporary, "wb"):
                pass
            return target_path
        finally:
            connection.close()
            await connection.wait_closed()

    async def upload_size(self, server: SftpServer, target_path: str, upload_id: str) -> int:
        """Return the byte count confirmed by the remote SFTP server."""
        temporary_path = self._upload_temp_path(target_path, upload_id)
        if server.adapter_type == "MOCK":
            temporary = self._mock_path(temporary_path)
            if not temporary.is_file():
                raise FileNotFoundError(temporary_path)
            return temporary.stat().st_size

        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            attributes = await client.stat(self._remote_path(server, temporary_path))
            return int(attributes.size or 0)
        finally:
            connection.close()
            await connection.wait_closed()

    async def write_upload_chunk(
        self,
        server: SftpServer,
        target_path: str,
        upload_id: str,
        offset: int,
        chunks: AsyncIterator[bytes],
    ) -> int:
        """Write one request body to SFTP and return only after remote size verification."""
        temporary_path = self._upload_temp_path(target_path, upload_id)
        if server.adapter_type == "MOCK":
            temporary = self._mock_path(temporary_path)
            if not temporary.is_file():
                raise FileNotFoundError(temporary_path)
            if temporary.stat().st_size != offset:
                raise ValueError("upload offset does not match the remote file")
            with temporary.open("r+b") as output:
                output.seek(offset)
                async for chunk in chunks:
                    if chunk:
                        output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            return temporary.stat().st_size

        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            temporary = self._remote_path(server, temporary_path)
            attributes = await client.stat(temporary)
            if int(attributes.size or 0) != offset:
                raise ValueError("upload offset does not match the remote file")
            async with client.open(temporary, "r+b") as output:
                await output.seek(offset)
                async for chunk in chunks:
                    if chunk:
                        await output.write(chunk)
            attributes = await client.stat(temporary)
            return int(attributes.size or 0)
        finally:
            connection.close()
            await connection.wait_closed()

    async def complete_upload(
        self,
        server: SftpServer,
        target_path: str,
        upload_id: str,
        expected_size: int,
        *,
        replace: bool = False,
    ) -> str:
        """Verify and atomically expose a fully written temporary object."""
        target_path = canonical_path(target_path)
        temporary_path = self._upload_temp_path(target_path, upload_id)
        if await self.upload_size(server, target_path, upload_id) != expected_size:
            raise ValueError("remote upload size does not match the expected file size")
        if server.adapter_type == "MOCK":
            if self._mock_path(target_path).exists() and not replace:
                raise FileExistsError(target_path)
            os.replace(self._mock_path(temporary_path), self._mock_path(target_path))
            return target_path

        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            if not replace:
                try:
                    await client.stat(self._remote_path(server, target_path))
                    raise FileExistsError(target_path)
                except asyncssh.SFTPNoSuchFile:
                    pass
            await client.rename(
                self._remote_path(server, temporary_path),
                self._remote_path(server, target_path),
            )
            return target_path
        finally:
            connection.close()
            await connection.wait_closed()

    async def abort_upload(self, server: SftpServer, target_path: str, upload_id: str) -> None:
        """Best-effort removal of a resumable upload's temporary remote object."""
        temporary_path = self._upload_temp_path(target_path, upload_id)
        if server.adapter_type == "MOCK":
            self._mock_path(temporary_path).unlink(missing_ok=True)
            return
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            try:
                await client.remove(self._remote_path(server, temporary_path))
            except asyncssh.SFTPNoSuchFile:
                pass
        finally:
            connection.close()
            await connection.wait_closed()

    async def download(self, server: SftpServer, path: str) -> AsyncIterator[bytes]:
        path = canonical_path(path)
        if server.adapter_type == "MOCK":
            target = self._mock_path(path)
            if not target.is_file():
                raise FileNotFoundError(path)
            with target.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    yield chunk
                    await asyncio.sleep(0)
            return
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            remote = posixpath.join(server.root_path, path.lstrip("/"))
            async with client.open(remote, "rb") as source:
                while chunk := await source.read(1024 * 1024):
                    yield chunk
        finally:
            connection.close()
            await connection.wait_closed()

    async def create_folder(self, server: SftpServer, parent: str, name: str) -> str:
        path = canonical_path(posixpath.join(canonical_path(parent), valid_name(name)))
        if server.adapter_type == "MOCK":
            self._mock_path(path).mkdir()
            return path
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            await client.mkdir(posixpath.join(server.root_path, path.lstrip("/")))
            return path
        finally:
            connection.close()
            await connection.wait_closed()

    async def rename(self, server: SftpServer, path: str, name: str) -> str:
        path = canonical_path(path)
        destination = canonical_path(posixpath.join(posixpath.dirname(path), valid_name(name)))
        return await self.move(server, path, destination)

    async def move(self, server: SftpServer, source: str, destination: str) -> str:
        source, destination = canonical_path(source), canonical_path(destination)
        if server.adapter_type == "MOCK":
            source_path, destination_path = self._mock_path(source), self._mock_path(destination)
            if destination_path.exists():
                raise FileExistsError(destination)
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.rename(destination_path)
            return destination
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            await client.rename(
                posixpath.join(server.root_path, source.lstrip("/")),
                posixpath.join(server.root_path, destination.lstrip("/")),
            )
            return destination
        finally:
            connection.close()
            await connection.wait_closed()

    async def delete(self, server: SftpServer, path: str) -> None:
        path = canonical_path(path)
        if path == "/":
            raise ValueError("cannot delete root")
        if server.adapter_type == "MOCK":
            target = self._mock_path(path)
            if target.is_dir():
                target.rmdir()
            else:
                target.unlink()
            return
        connection = await self._connect(server)
        try:
            client = await connection.start_sftp_client()
            remote = posixpath.join(server.root_path, path.lstrip("/"))
            attrs = await client.lstat(remote)
            if attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
                await client.rmdir(remote)
            else:
                await client.remove(remote)
        finally:
            connection.close()
            await connection.wait_closed()


def seed_mock_files(root: Path) -> None:
    (root / "finance" / "month-end").mkdir(parents=True, exist_ok=True)
    (root / "shared").mkdir(parents=True, exist_ok=True)
    welcome = root / "shared" / "welcome.txt"
    template = root / "finance" / "month-end" / "upload-template.csv"
    if not welcome.exists():
        welcome.write_text("Welcome to the SFTP Management Portal mock server.\n", encoding="utf-8")
    if not template.exists():
        template.write_text("account,amount\nexample,0\n", encoding="utf-8")
