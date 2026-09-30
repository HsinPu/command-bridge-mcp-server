# 安全檔案傳輸 / Secure file transfer (3.1.0)

CommandBridge adds `command_bridge_upload_file` and `command_bridge_download_file`. Both are **disabled by default**, independently of command allowlist/unrestricted mode. They transfer bytes through MCP; they never execute, extract, fetch a URL, or invoke sudo. Clients must separately support reading/writing their own local files. These tools cannot directly access a path on the client's computer.

## Enable explicitly / 明確啟用

Append `--enable-file-transfer` to the Linux bootstrap installation arguments, or `-EnableFileTransfer` on Windows. Upload-only/download-only options are `--enable-upload` / `--enable-download`, and `-EnableUpload` / `-EnableDownload`. Reinstallation preserves transfer settings when these options are omitted. To disable an operation, set its environment value to `false` and restart the service.

| Setting | Default / meaning |
| --- | --- |
| `COMMAND_BRIDGE_UPLOAD_ENABLED` | `false` |
| `COMMAND_BRIDGE_DOWNLOAD_ENABLED` | `false` |
| `COMMAND_BRIDGE_TRANSFER_ROOT` | Required existing absolute directory when either operation is enabled |
| `COMMAND_BRIDGE_TRANSFER_MAX_BYTES` | `5242880`; may be reduced, never increased beyond 5 MiB |

Linux managed directories are `/var/lib/command-bridge/transfers` or `/var/lib/command-bridge-installer/transfers`. They must belong to the service account and have mode `0700`. The installer provisions them as that account, without privileged recursive ownership changes. Windows uses `%ProgramData%\CommandBridgeMCP\transfers`, owned by Administrators, with protected ancestor ACLs. LocalService can create files and modify child files but cannot delete the directory, change its ACL/owner, or set directory attributes. A custom Windows directory must meet the same verified ownership and ACL requirements; a normal user-owned directory is rejected.

## Requests / 使用方式

Upload arguments:

```json
{"path":"example.bin","contentBase64":"AAE=","sha256":"b413f47d13ee2fe6c845b2ee141af81de858df4ec549a58b7970bb96645bc8d2"}
```

The hash is the lowercase SHA-256 of the decoded bytes. Base64 must be canonical. Download takes `{"path":"example.bin"}` and returns `contentBase64`, `size`, `sha256`, `path`, `auditId`, and `ok`. Upload returns the same metadata without file content. Compare download size/hash before saving the local file. MCP clients and model interfaces may impose smaller response limits; Base64 and duplicated text/structured output increase the transmitted size.

僅接受單層檔名：英數字開頭，其餘為英數字、`.`、`_`、`-`，最多 120 字元。禁止子目錄、絕對路徑、`..` 路徑跳脫、Windows ADS／保留名稱、隱藏檔及政策／Audit／Token 保留名稱。只能傳一般檔案；symlink、junction、特殊檔案及下載硬連結都會拒絕。

**第一版不覆寫既有檔案。** `overwrite:true` 一律拒絕，`expectedSha256` 不會啟用替換。跨平台一般檔案 API 無法保證「檢查舊雜湊後，替換時仍是同一個檔案」，所以保守採用新檔名及原子、不取代既有檔案的發布方式。上傳先寫同目錄私有暫存檔、同步資料，再以 exclusive hard link 發布；不支援這項操作的檔案系統會失敗，不退回不安全的覆寫。

## Security and failures / 安全與失敗

Linux operations anchor the directory through an open descriptor under `/proc/self/fd`. Windows verifies protected directory/ancestor ACLs and holds a native directory handle without delete sharing throughout the operation. It rejects failure to obtain or retain that protection. Downloads check descriptor identity, link count, size and modification times before and after reading. This protects the transfer boundary; it is not a filesystem sandbox against administrators, a compromised service account, or separately enabled unrestricted commands.

Only one transfer is active at a time; there is no waiting queue. The directory is limited to 1,000 entries, each transfer to 5 MiB and a 15-second response deadline. HTTP authenticates before parsing upload bodies, caps body size and permits at most four concurrent MCP requests when transfers are enabled. Timed-out storage operations retain the transfer slot until actual cleanup finishes, rather than starting unlimited work. Filesystem calls themselves may outlive a deadline.

Cancellation, timeout or a failed response **does not prove an upload was rolled back**. An exclusive publication may already have completed. Query Audit and inspect the destination before retrying. Terminal Audit failure after publication reports `FILE_COMMITTED_AUDIT_FAILED`; download content is withheld when terminal Audit fails. A crash/power loss may leave `.upload-*` temporary files. New transfers refuse to proceed while these remain; an administrator should stop the service, inspect and clean only those verified leftovers. No automatic deletion of arbitrary files occurs.

每次進入傳輸流程先寫 `attempted`，再嘗試唯一終結事件 `blocked`、`completed` 或 `failed`。初始 Audit 失敗不操作檔案。既有 schemaVersion 1 事件新增選用 `fileTransfer` 欄位：operation、安全檔名、大小、SHA-256、committed；不記錄 Base64 或檔案內容。尚未通過 MCP 輸入 schema 的請求不會進入傳輸 Audit。Audit 不是不可竄改或內容備份。

The Bearer Token authorizes all enabled operations; there are no per-user transfer roles. Use private HTTPS routing for sensitive files, or a trusted LAN/VPN for the native HTTP listener. The installer does not provide TLS or open firewall rules. Never disable certificate verification. Normal uninstall preserves managed transfer data with other state; purge follows the platform's managed-directory deletion rules. Custom roots are not automatically removed. Read [Linux](linux-systemd.md) and [Windows](windows-service.md) lifecycle guidance before purge.
