from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from vercel.blob import BlobNotFoundError

from app.sftp.blob_storage import VercelBlobMockStorage


class FakeMultipartUploader:
    def __init__(self, client: "FakeBlobClient", path: str):
        self.client = client
        self.path = path
        self.parts: dict[int, bytes] = {}

    async def upload_part(self, part_number: int, body: bytes) -> SimpleNamespace:
        self.parts[part_number] = body
        return SimpleNamespace(part_number=part_number, etag=f"part-{part_number}")

    async def complete(self, parts: list[SimpleNamespace]) -> None:
        self.client.objects[self.path] = b"".join(self.parts[part.part_number] for part in parts)


class FakeBlobClient:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.closed = False

    def _metadata(self, path: str) -> SimpleNamespace:
        content = self.objects[path]
        return SimpleNamespace(
            pathname=path,
            size=len(content),
            uploaded_at=datetime.now(timezone.utc),
            download_url=f"https://example.test/{path}",
        )

    async def head(self, path: str) -> SimpleNamespace:
        if path not in self.objects:
            raise BlobNotFoundError()
        return self._metadata(path)

    async def iter_objects(self, *, prefix: str | None = None, limit: int | None = None, **_kwargs):  # type: ignore[no-untyped-def]
        count = 0
        for path in sorted(self.objects):
            if prefix is not None and not path.startswith(prefix):
                continue
            yield self._metadata(path)
            count += 1
            if limit is not None and count >= limit:
                return

    async def put(self, path: str, body: bytes, *, overwrite: bool = False, **_kwargs) -> SimpleNamespace:  # type: ignore[no-untyped-def]
        if path in self.objects and not overwrite:
            raise RuntimeError("already exists")
        self.objects[path] = bytes(body)
        return self._metadata(path)

    async def get(self, path: str, **_kwargs) -> SimpleNamespace:  # type: ignore[no-untyped-def]
        if path not in self.objects:
            raise BlobNotFoundError()
        return SimpleNamespace(content=self.objects[path])

    async def copy(self, source: str, destination: str, *, overwrite: bool = False, **_kwargs) -> SimpleNamespace:  # type: ignore[no-untyped-def]
        if destination in self.objects and not overwrite:
            raise RuntimeError("already exists")
        self.objects[destination] = self.objects[source]
        return self._metadata(destination)

    async def delete(self, paths):  # type: ignore[no-untyped-def]
        for path in [paths] if isinstance(paths, str) else paths:
            self.objects.pop(path, None)

    async def create_multipart_uploader(self, path: str, **_kwargs) -> FakeMultipartUploader:  # type: ignore[no-untyped-def]
        return FakeMultipartUploader(self, path)

    async def aclose(self) -> None:
        self.closed = True


class AwaitableIteratorBlobClient(FakeBlobClient):
    async def iter_objects(self, *, prefix: str | None = None, limit: int | None = None, **_kwargs):  # type: ignore[no-untyped-def]
        async def items():  # type: ignore[no-untyped-def]
            count = 0
            for path in sorted(self.objects):
                if prefix is not None and not path.startswith(prefix):
                    continue
                yield self._metadata(path)
                count += 1
                if limit is not None and count >= limit:
                    return

        return items()


async def bytes_iterator(content: bytes):  # type: ignore[no-untyped-def]
    yield content


@pytest.mark.asyncio
async def test_blob_mock_storage_persists_seed_and_resumable_uploads() -> None:
    client = FakeBlobClient()
    storage = VercelBlobMockStorage("test-token", client=client)
    await storage.seed()

    root = await storage.list("/")
    assert [(item["name"], item["type"]) for item in root] == [
        ("finance", "folder"),
        ("shared", "folder"),
    ]
    assert [item["name"] for item in await storage.list("/shared")] == ["welcome.txt"]

    upload_id = "12345678-1234-1234-1234-123456789abc"
    first = b"a" * (4 * 1024 * 1024)
    second = b"b" * (2 * 1024 * 1024)
    await storage.begin_upload("/shared/report.bin", upload_id, replace=False)
    assert await storage.write_upload_chunk(upload_id, 0, bytes_iterator(first)) == len(first)
    assert await storage.write_upload_chunk(upload_id, len(first), bytes_iterator(second)) == len(first) + len(second)
    assert await storage.upload_size(upload_id) == len(first) + len(second)

    assert await storage.complete_upload(
        "/shared/report.bin",
        upload_id,
        len(first) + len(second),
        replace=False,
    ) == "/shared/report.bin"
    assert client.objects["sftp-manager-demo/files/shared/report.bin"] == first + second
    assert await storage.complete_upload(
        "/shared/report.bin",
        upload_id,
        len(first) + len(second),
        replace=False,
    ) == "/shared/report.bin"

    await storage.close()
    assert client.closed is True


@pytest.mark.asyncio
async def test_blob_mock_storage_preserves_file_and_folder_mutation_contracts() -> None:
    client = FakeBlobClient()
    storage = VercelBlobMockStorage("test-token", client=client)
    await storage.seed()

    await storage.create_folder("/shared/incoming")
    with pytest.raises(FileExistsError):
        await storage.create_folder("/shared/incoming")
    await storage.move("/shared/welcome.txt", "/shared/incoming/welcome.txt")
    assert [item["name"] for item in await storage.list("/shared/incoming")] == ["welcome.txt"]
    with pytest.raises(OSError):
        await storage.delete("/shared/incoming")
    await storage.delete("/shared/incoming/welcome.txt")
    await storage.delete("/shared/incoming")
    assert [item["name"] for item in await storage.list("/shared")] == []


@pytest.mark.asyncio
async def test_blob_mock_storage_supports_awaitable_sdk_object_iterator() -> None:
    storage = VercelBlobMockStorage("test-token", client=AwaitableIteratorBlobClient())

    await storage.seed()

    assert [item["name"] for item in await storage.list("/")] == ["finance", "shared"]
