# SFTP servers and file operations

Owner: SFTP and transfer services. Related modules:
[identity and grants](02-identity-and-access.md), [audit](06-audit.md),
[security](08-security-and-accessibility.md).

## SFTP server administration

Only Admins may create, edit, enable, disable, test, rotate credentials for, or remove an SFTP server configuration.

Each server contains:

- Unique ID, display name, description, host, port, username, authentication type, configured remote root, pinned host-key fingerprint, enabled state, connection/operation timeouts, created/updated metadata, and integer version.
- Either a password or a private key and optional passphrase. Secrets are encrypted with AES-256-GCM using a key supplied through `APP_CREDENTIAL_ENCRYPTION_KEY_FILE`.
- A sanitized last-test result containing timestamp, latency, success/failure, and a safe error code.

Rules:

- Port defaults to 22 and must be between 1 and 65535.
- The remote root must be an absolute normalized POSIX path.
- Host-key verification is mandatory after initial enrollment. During server creation, the backend connects and authenticates first, retrieves the server's SHA-256 host-key fingerprint from the SSH handshake, and saves that fingerprint automatically in the same successful operation. The form never asks the Admin to enter a fingerprint.
- Initial enrollment uses trust on first use (TOFU). The saved fingerprint is visible on the server record for optional out-of-band verification, and every subsequent connection fails closed if the presented host key differs.
- A server configuration is not stored when the initial connection, authentication, or fingerprint discovery fails. Editing connection identity fields triggers the same connect-and-repin workflow before changes are committed.
- Secrets are write-only. Read APIs return only `credentialConfigured`, authentication type, and last-rotated timestamp.
- Editing non-secret fields leaves the credential unchanged. Credential replacement is a separate rotation action.
- Disabling a server immediately removes it from user navigation and rejects new operations and task targets.
- Server removal requires an explicit confirmation naming the server and describing the cascade. In one SQLite transaction, removal deletes the server row and encrypted credential together with every associated direct/group folder grant, task definition/instance or current task record, and unfinished resumable upload-session record. Immutable audit history is retained with a server-name snapshot and deleted-record counts, and remote SFTP folders/files are never deleted by removal.
- Connection tests do not persist a configuration unless the subsequent create/update request succeeds.
- Plaintext credential material must be zeroed or dereferenced promptly after use and must never be serialized to logs, errors, metrics, or audit metadata.

The server list is the default Admin view. An **Add another SFTP server** button expands the otherwise-collapsed form. After a successful connection and save, the form closes, clears sensitive fields, and the refreshed server list remains visible. A failed connection keeps the form open with a safe error so the Admin can correct it.

## Folder and file explorer

The explorer provides server and access-root selection, breadcrumbs bounded by the visible access root, a sortable directory table, and permitted actions.

- The page toolbar displays **Upload files** and **Create folder** when the current folder grants those operations.
- Each file row displays **Download** plus any authorized rename, move, replace, or delete actions. Each folder row opens the child folder and displays any authorized management actions.
- Upload and download remain available to Admins and to any non-Auditor user with the corresponding folder grant. Auditors may download only when granted `DOWNLOAD` and can never upload or modify content.

#### Listing and metadata

- Folder listing requires `LIST` and returns name, relative path, type, size, modified time, and allowed actions.
- Successful folder listings are not written to audit history. A rejected listing still produces the standard authorization-denial or sensitive-validation audit event.
- Results sort folders before files by default and support server-side pagination.
- Hidden files are shown only when `SHOW_HIDDEN_FILES=true`; authorization rules remain unchanged.
- Symlinks are omitted and generate a safe diagnostic metric, not a user-visible target.

#### Upload

- Upload requires `UPLOAD` on the destination folder.
- The browser first creates a durable upload session, then sends the file as bounded raw binary chunks. The backend streams each request body directly to a uniquely named temporary object in the target SFTP folder without staging the complete file on the frontend or backend filesystem.
- On success, the temporary file is atomically renamed to the requested filename. Explicit cancellation and unrecoverable failures trigger best-effort temporary-object cleanup; transient interruptions retain the resumable object as described below.
- Users may choose one or more files with the system picker or drag and drop one or more files directly onto the current folder's directory-listing card. The listing card highlights while files are dragged over it; no separate drag-and-drop section is displayed. Every selected file captures the server and folder visible at selection time, so the user may navigate elsewhere and enqueue files for another folder without changing earlier destinations.
- Upload ownership lives in an application-level background manager rather than the Files page. Changing menus or routes does not cancel active uploads. A responsive floating window in the bottom-right corner remains visible across application navigation and shows each filename, captured server/folder destination, SFTP-confirmed progress, and state.
- The floating upload window has a Material Symbol minimize action. Its minimized state remains a single compact row containing the upload count, aggregate SFTP-confirmed progress bar and percentage, a pause/resume-all action, a cancel-all action, and an expand action. Aggregate progress is calculated as total remotely confirmed bytes divided by the total bytes of all visible jobs. Batch actions affect only unfinished eligible jobs and do not change completed uploads.
- Multiple independent files may upload concurrently to the same or different authorized folders. The browser runs up to two upload sessions concurrently by default and queues additional files, matching the default per-user transfer limit; backend authorization, configurable per-user/global limits, and distinct temporary objects remain authoritative. Concurrent non-replacement uploads targeting the same final path must never silently overwrite one another: the first completion succeeds and later completion attempts return HTTP 409.
- A chunk response reports `receivedBytes` only after the SFTP write completes and a remote `stat` confirms the temporary object's new size. The UI progress bar and percentage use this SFTP-confirmed byte count, never browser-to-proxy transmission progress. After the confirmed count reaches 100%, the UI indicates that the atomic final rename is in progress until the completion endpoint responds.
- Each queued or active upload has accessible pause and cancel icon buttons in the floating window. Pause aborts only the current bounded chunk request, retains the remote temporary object and durable upload-session record, and frees a concurrent-upload slot. Resume queries the remote temporary-object size and continues from the SFTP-confirmed offset; already confirmed chunks are not resent.
- A browser/network interruption, timeout, or temporary remote failure leaves that file and upload-session ID available in the floating window with an accessible retry/resume icon. Retrying follows the same remote-offset reconciliation used after pause.
- Explicit cancellation aborts the active request and performs best-effort deletion of only that upload's remote temporary object and durable upload-session record without interrupting other uploads. An interrupted request retains the partial temporary object so it can be resumed safely.
- The default chunk size is 4 MiB and may be configured from 64 KiB to 8 MiB. Each chunk request is rejected if it exceeds the advertised limit or would exceed the declared file size.
- Existing destinations are never silently overwritten. A conflict returns HTTP 409. Replacement requires explicit UI confirmation plus both `UPLOAD` and `DELETE`; the backend performs a replace operation with its own idempotency key and audit event.
- The filename must be a single valid path segment and pass length and character validation.
- A successful upload is evaluated against eligible automatic-completion task rules.

#### Download

- Download requires `DOWNLOAD` on the file's parent folder.
- The response streams from SFTP, sets a safe `Content-Disposition` filename, disables MIME sniffing, and never caches private content in a shared cache.
- Partial/range download is outside v1. Interrupted downloads are audited as failures or cancellations.

#### Create, rename, move, and delete

- Create-folder requires `CREATE_FOLDER` on the parent.
- Rename requires `RENAME` on the parent and rejects collisions with HTTP 409.
  Selecting Rename replaces that row's displayed file/folder name with a
  pre-populated inline text field; native browser prompt/alert input is not
  used. Save and Cancel controls remain beside the field, Enter saves, and
  Escape cancels. While saving, the inline Save control shows progress and
  conflicting actions for that row are disabled. A successful rename closes
  the editor, refreshes the listing, and shows confirmation; a validation or
  API failure keeps the editor open and displays readable highlighted guidance
  directly below its field.
- Move is limited to one configured SFTP server. It requires `MOVE` at the source parent and `UPLOAD` for a file or `CREATE_FOLDER` for a folder at the destination parent. Both paths must remain within authorized roots.
- File deletion and empty-folder deletion require `DELETE` on the parent.
- Non-empty folder deletion returns HTTP 409. Recursive delete is not supported.
- Operations that the remote server cannot perform atomically must fail safely and must not report success until the final state is verified.
