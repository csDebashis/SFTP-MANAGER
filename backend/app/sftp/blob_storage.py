"""Private Vercel Blob storage for the durable demonstration SFTP adapter."""

from __future__ import annotations

import mimetypes
import posixpath
from inspect import isawaitable
from collections.abc import AsyncIterator
from typing import Any

import httpx
from vercel.blob import AsyncBlobClient, BlobNotFoundError


FOLDER_MARKER = ".sftp-manager-folder"
MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024


class VercelBlobMockStorage:
    """Present a private Blob prefix as the MOCK server's POSIX filesystem."""

    def __init__(self, token: str, prefix: str = "sftp-manager-demo", client: Any | None = None):
        normalized_prefix = prefix.strip().strip("/")
        if not normalized_prefix or ".." in normalized_prefix.split("/"):
            raise ValueError("BLOB_SFTP_PREFIX must be a safe non-empty Blob prefix")
        self.token = token
        self.prefix = normalized_prefix
        self.client = client or AsyncBlobClient(token=token)

    @property
    def files_prefix(self) -> str:
        return f"{self.prefix}/files"

    @property
    def uploads_prefix(self) -> str:
        return f"{self.prefix}/uploads"

    @staticmethod
    def _logical(path: str) -> str:
        if not path.startswith("/"):
            raise ValueError("Blob mock paths must be absolute")
        return posixpath.normpath(path)

    def _file_key(self, path: str) -> str:
        logical = self._logical(path)
        return self.files_prefix if logical == "/" else f"{self.files_prefix}{logical}"

    def _folder_marker(self, path: str) -> str:
        return f"{self._file_key(path).rstrip('/')}/{FOLDER_MARKER}"

    def _upload_prefix(self, upload_id: str) -> str:
        return f"{self.uploads_prefix}/{upload_id}"

    async def _head_optional(self, key: str) -> Any | None:
        try:
            return await self.client.head(key)
        except BlobNotFoundError:
            return None

    async def _objects(self, prefix: str) -> list[Any]:
        return [item async for item in self._iter_objects(prefix=prefix)]

    async def _iter_objects(self, *, prefix: str, limit: int | None = None) -> AsyncIterator[Any]:
        objects = self.client.iter_objects(prefix=prefix, limit=limit)
        if isawaitable(objects):
            objects = await objects
        async for item in objects:
            yield item

    async def _kind(self, path: str) -> str | None:
        if self._logical(path) == "/":
            return "folder"
        if await self._head_optional(self._file_key(path)) is not None:
            return "file"
        if await self._head_optional(self._folder_marker(path)) is not None:
            return "folder"
        prefix = f"{self._file_key(path).rstrip('/')}/"
        async for _item in self._iter_objects(prefix=prefix, limit=1):
            return "folder"
        return None

    async def list(self, path: str) -> list[dict[str, Any]]:
        path = self._logical(path)
        if await self._kind(path) != "folder":
            raise FileNotFoundError(path)
        prefix = f"{self._file_key(path).rstrip('/')}/"
        folders: dict[str, float] = {}
        files: dict[str, dict[str, Any]] = {}
        async for item in self._iter_objects(prefix=prefix):
            relative = item.pathname[len(prefix):]
            if not relative or relative == FOLDER_MARKER:
                continue
            first, separator, _rest = relative.partition("/")
            modified = item.uploaded_at.timestamp()
            if separator:
                folders[first] = max(folders.get(first, 0), modified)
            elif first != FOLDER_MARKER:
                files[first] = {
                    "name": first,
                    "path": self._logical(posixpath.join(path, first)),
                    "type": "file",
                    "size": item.size,
                    "modifiedAt": modified,
                }
        result = [
            {
                "name": name,
                "path": self._logical(posixpath.join(path, name)),
                "type": "folder",
                "size": 0,
                "modifiedAt": modified,
            }
            for name, modified in folders.items()
        ]
        result.extend(files.values())
        return sorted(result, key=lambda item: (item["type"] != "folder", item["name"].lower()))

    async def begin_upload(self, target_path: str, upload_id: str, *, replace: bool) -> None:
        if await self._kind(target_path) is not None and not replace:
            raise FileExistsError(target_path)
        await self.abort_upload(upload_id)

    async def _parts(self, upload_id: str) -> list[Any]:
        prefix = f"{self._upload_prefix(upload_id)}/parts/"
        parts = await self._objects(prefix)
        try:
            return sorted(parts, key=lambda item: int(item.pathname[len(prefix):]))
        except ValueError as exc:
            raise ValueError("invalid persisted upload part") from exc

    async def upload_size(self, upload_id: str) -> int:
        completion_key = f"{self._upload_prefix(upload_id)}/completed"
        if await self._head_optional(completion_key) is not None:
            completion = await self.client.get(completion_key, access="private", use_cache=False)
            target_path = completion.content.decode("utf-8")
            completed_target = await self._head_optional(self._file_key(target_path))
            if completed_target is None:
                raise ValueError("completed Blob upload target is missing")
            return completed_target.size
        prefix = f"{self._upload_prefix(upload_id)}/parts/"
        confirmed = 0
        for item in await self._parts(upload_id):
            offset = int(item.pathname[len(prefix):])
            if offset != confirmed:
                raise ValueError("persisted upload parts are not contiguous")
            confirmed += item.size
        return confirmed

    async def write_upload_chunk(self, upload_id: str, offset: int, chunks: AsyncIterator[bytes]) -> int:
        if await self.upload_size(upload_id) != offset:
            raise ValueError("upload offset does not match Blob storage")
        content = bytearray()
        async for chunk in chunks:
            if chunk:
                content.extend(chunk)
        if not content:
            return offset
        key = f"{self._upload_prefix(upload_id)}/parts/{offset:020d}"
        try:
            await self.client.put(
                key,
                bytes(content),
                access="private",
                add_random_suffix=False,
                overwrite=False,
            )
        except Exception:
            persisted = await self._head_optional(key)
            if persisted is None or persisted.size != len(content):
                raise
        return offset + len(content)

    async def _assemble_staging_blob(self, upload_id: str, expected_size: int) -> str:
        staging_key = f"{self._upload_prefix(upload_id)}/assembled"
        existing = await self._head_optional(staging_key)
        if existing is not None:
            if existing.size != expected_size:
                raise ValueError("persisted staging object has the wrong size")
            return staging_key
        if expected_size == 0:
            await self.client.put(
                staging_key,
                b"",
                access="private",
                add_random_suffix=False,
                overwrite=True,
            )
            return staging_key

        parts = await self._parts(upload_id)
        uploader = await self.client.create_multipart_uploader(
            staging_key,
            access="private",
            add_random_suffix=False,
            overwrite=True,
        )
        uploaded_parts = []
        buffer = bytearray()
        part_number = 1
        for index, item in enumerate(parts):
            result = await self.client.get(item.pathname, access="private", use_cache=False)
            if len(result.content) != item.size:
                raise ValueError("Blob upload part size changed during completion")
            buffer.extend(result.content)
            is_last = index == len(parts) - 1
            if len(buffer) >= MIN_MULTIPART_PART_SIZE or is_last:
                uploaded_parts.append(await uploader.upload_part(part_number, bytes(buffer)))
                part_number += 1
                buffer.clear()
        await uploader.complete(uploaded_parts)
        staged = await self._head_optional(staging_key)
        if staged is None or staged.size != expected_size:
            raise ValueError("Blob storage did not confirm the assembled upload size")
        return staging_key

    async def complete_upload(
        self,
        target_path: str,
        upload_id: str,
        expected_size: int,
        *,
        replace: bool,
    ) -> str:
        completion_key = f"{self._upload_prefix(upload_id)}/completed"
        if await self._head_optional(completion_key) is not None:
            completed_target = await self._head_optional(self._file_key(target_path))
            if completed_target is None or completed_target.size != expected_size:
                raise ValueError("completed Blob upload target is missing")
            return target_path
        if await self.upload_size(upload_id) != expected_size:
            raise ValueError("Blob upload size does not match the expected file size")
        if await self._kind(target_path) is not None and not replace:
            raise FileExistsError(target_path)

        staging_key = await self._assemble_staging_blob(upload_id, expected_size)
        target_key = self._file_key(target_path)
        await self.client.copy(
            staging_key,
            target_key,
            access="private",
            add_random_suffix=False,
            overwrite=replace,
        )
        await self.client.put(
            completion_key,
            target_path.encode("utf-8"),
            access="private",
            add_random_suffix=False,
            overwrite=True,
        )
        cleanup = [item.pathname for item in await self._parts(upload_id)] + [staging_key]
        if cleanup:
            await self.client.delete(cleanup)
        return target_path

    async def abort_upload(self, upload_id: str) -> None:
        keys = [item.pathname for item in await self._objects(f"{self._upload_prefix(upload_id)}/")]
        if keys:
            await self.client.delete(keys)

    async def download(self, path: str) -> AsyncIterator[bytes]:
        metadata = await self._head_optional(self._file_key(path))
        if metadata is None:
            raise FileNotFoundError(path)
        headers = {"Authorization": f"Bearer {self.token}"}
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", metadata.download_url, headers=headers, follow_redirects=True) as response:
                if response.status_code == 404:
                    raise FileNotFoundError(path)
                response.raise_for_status()
                async for chunk in response.aiter_bytes(1024 * 1024):
                    if chunk:
                        yield chunk

    async def create_folder(self, path: str) -> None:
        if await self._kind(path) is not None:
            raise FileExistsError(path)
        parent = posixpath.dirname(path) or "/"
        if await self._kind(parent) != "folder":
            raise FileNotFoundError(parent)
        await self.client.put(
            self._folder_marker(path),
            b"",
            access="private",
            add_random_suffix=False,
            overwrite=False,
        )

    async def move(self, source: str, destination: str) -> None:
        kind = await self._kind(source)
        if kind is None:
            raise FileNotFoundError(source)
        if await self._kind(destination) is not None:
            raise FileExistsError(destination)
        if kind == "file":
            await self.client.copy(
                self._file_key(source),
                self._file_key(destination),
                access="private",
                add_random_suffix=False,
                overwrite=False,
            )
            await self.client.delete(self._file_key(source))
            return
        source_prefix = f"{self._file_key(source).rstrip('/')}/"
        destination_prefix = f"{self._file_key(destination).rstrip('/')}/"
        objects = await self._objects(source_prefix)
        for item in objects:
            await self.client.copy(
                item.pathname,
                f"{destination_prefix}{item.pathname[len(source_prefix):]}",
                access="private",
                add_random_suffix=False,
                overwrite=False,
            )
        if objects:
            await self.client.delete([item.pathname for item in objects])

    async def delete(self, path: str) -> None:
        kind = await self._kind(path)
        if kind is None:
            raise FileNotFoundError(path)
        if kind == "file":
            await self.client.delete(self._file_key(path))
            return
        marker = self._folder_marker(path)
        children = [item for item in await self._objects(f"{self._file_key(path).rstrip('/')}/") if item.pathname != marker]
        if children:
            raise OSError("folder is not empty")
        if await self._head_optional(marker) is not None:
            await self.client.delete(marker)

    async def seed(self) -> None:
        for folder in ("/finance", "/finance/month-end", "/shared"):
            if await self._kind(folder) is None:
                await self.client.put(
                    self._folder_marker(folder),
                    b"",
                    access="private",
                    add_random_suffix=False,
                    overwrite=False,
                )
        defaults = {
            "/shared/welcome.txt": b"Welcome to the SFTP Management Portal mock server.\n",
            "/finance/month-end/upload-template.csv": b"account,amount\nexample,0\n",
        }
        for path, content in defaults.items():
            if await self._kind(path) is None:
                content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
                await self.client.put(
                    self._file_key(path),
                    content,
                    access="private",
                    content_type=content_type,
                    add_random_suffix=False,
                    overwrite=False,
                )

    async def clear(self) -> None:
        keys = [item.pathname for item in await self._objects(f"{self.prefix}/")]
        if keys:
            await self.client.delete(keys)

    async def close(self) -> None:
        close = getattr(self.client, "aclose", None)
        if close is not None:
            await close()
