# 中文與 UTF-8 / Chinese text and UTF-8 (6.0.5)

以 **UTF-8** 為主要文件格式。指令輸出、檔案内容與 MCP JSON 是不同的編碼邊界，不能只設定 stdout 就假設讀寫文件也安全。 / UTF-8 is the primary document format. Command output, file contents and MCP JSON have separate encoding boundaries.

## 指令輸出 / Command output

`command_bridge_run_command` 新增選用的 `outputEncoding`；省略時仍為 `utf8`。stdout 與 stderr 使用各自的串流解碼器，保留跨 buffer 的中文與 emoji。 / Omit the optional field to retain the UTF-8 default. Both output streams have independent incremental decoders.

| Value | Use / 用途 |
| --- | --- |
| `utf8` | UTF-8 programs; default / UTF-8 程式，預設值 |
| `utf16le` | Programs emitting UTF-16 little endian / 輸出 UTF-16LE 的程式 |
| `big5` | Programs explicitly configured for Big5 / 已確認使用 Big5 的舊程式 |
| `gbk` | Programs explicitly configured for GBK / 已確認使用 GBK 的程式 |
| `gb18030` | Programs explicitly configured for GB18030 / 已確認使用 GB18030 的程式 |

例如，已確認主機上的原生 `systeminfo` 輸出 Big5，且現有政策允許它時： / For a native program known to emit Big5 and allowed by the existing policy:

```json
{"command":"systeminfo","shell":"powershell","outputEncoding":"big5"}
```

這個值同時適用 stdout／stderr，不更動 argv、指令政策或檔案内容。不要猜測；有些錯誤編碼仍可解碼為無意義文字，混合編碼的同一串流也不能可靠自動判斷。Windows 原生 allowlist 程式仍直接執行，舊工具可能使用主機的傳統 code page；可選 UTF-8 的內建 Cmdlet 或指定已確認的編碼。 / The field selects decoding only, for both streams. It does not change policies, argv or file bytes. Do not guess; a wrong encoding can still produce valid but meaningless text. Mixed encodings within one stream are unsupported. Native Windows allowlist programs keep direct execution.

無法解碼、正常結束時留下不完整字元，會回報 `COMMAND_OUTPUT_ENCODING_INVALID`，不回傳已擷取的任何輸出；Audit 留下 attempted／failed，並回收程序名額。一般逾時、取消或截斷仍沿用原規則，不把被終止的半個字元補成亂碼。終結 Audit 失敗仍隱藏輸出。指令可能已經修改檔案，輸出錯誤**不代表檔案修改已回復**。 / Invalid output is withheld and audited as failed. Normal timeout/cancellation/truncation behavior and Audit gating remain. An output error does not roll back arbitrary program side effects.

## 升級遷移 / Upgrade migration

6.0.0 是大版：舊版即使程式輸出非 UTF-8，仍可能回傳含替代字元的結果；新版拒絕這種結果。有效 UTF-8 呼叫保持原樣，已確認使用 Big5／GBK／GB18030／UTF-16LE 的程式需加入對應 `outputEncoding`，不完整或混合編碼輸出應在來源程式修正，不能以猜測來繞過驗證。請一起更新服務與用戶端操作設定。 / Legacy calls that relied on substituted output must select their actual encoding. Valid UTF-8 calls are unchanged; repair incomplete/mixed output at its source.

cmd 包裝程式的主控台改為 UTF-8，內建 `echo` 等文字重新導向也可能從原本的傳統 code page 改成 UTF-8。`outputEncoding` 不會改變這個寫檔行為；不可直接附加到已存在的 Big5／UTF-16LE 文件。先核對原檔，再由支援明確編碼的工具寫入經驗證候選檔。受管理設定須先以備份確認為有效 UTF-8；不要自動轉碼整個資料目錄或忽略非法 Audit 位元組。 / cmd text redirection can now emit UTF-8. The output selector does not control file writes; do not append to a differently encoded existing file. Verify encoding and a candidate before replacement, keeping original bytes.

## Windows

cmd 在沒有主控台的服務中不能只靠 `chcp 65001` 保證輸出。6.0.0 使用固定 PowerShell 主控台包裝程式設定 UTF-8，再以 cmd 的 `/d /s /c` 規則執行 Shell 文字、平行轉送原始 stdout／stderr，保留引號、exit code 和程序樹終止。整個包裝流程包含在既有逾時內；不更動系統語系，也不將原生 allowlist 交給 Shell。忽略主控台編碼的外部程式仍需明確設定自己的輸出。 / A fixed UTF-8 console host handles cmd Shell execution, including when Node has no console. It preserves quoting, exit status and raw streams within the existing timeout. External programs that ignore console encoding still need their own configuration.

PowerShell 的 `[Console]::OutputEncoding`、`$OutputEncoding` **不會指定檔案讀寫編碼**。Windows PowerShell 5.1 的無 BOM `Get-Content` 可能採 ANSI，`Set-Content`／`Add-Content` 的預設也可能是 ANSI；`Out-File`、`>`、`>>` 預設 UTF-16LE。PowerShell 7 的預設不同。詳見 [Microsoft encoding documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1)。 / Console settings do not set file encoding; Windows PowerShell 5.1 and PowerShell 7 have different defaults.

UTF-8 讀取示例（仍須通過既有指令／cwd 政策）： / A UTF-8 read, subject to existing command and cwd policies:

```powershell
Get-Content -LiteralPath 'C:\work\中文文件.txt' -Raw -Encoding UTF8
```

這個 Cmdlet 不是嚴格的位元組驗證。管理員編輯整份 UTF-8 文件時，先備份原始位元組並用 `[Text.UTF8Encoding]::new($false,$true).GetString($bytes)` 嚴格解碼；依原檔保留 UTF-8 BOM、CRLF／LF 與最後換行，以明確的 UTF-8 寫入暫存候選檔，核對內容和雜湊後才替換，保留原 ACL。不要把一般讀取的容錯結果或截斷內容拿來覆寫全文。不用全域 `$PSDefaultParameterValues` 猜測所有現有檔案的格式。 / Back up bytes, strictly decode, preserve BOM/newlines/final newline, verify a temporary candidate and retain the original ACL before replacing a document. Avoid global encoding overrides and rewriting from incomplete output.

含中文的 `.ps1` 若要由 Windows PowerShell 5.1 執行，使用 UTF-8 BOM；無 BOM 的非 ASCII 腳本可能被當成 ANSI。專案的正式 PowerShell 腳本維持 ASCII 或含 UTF-8 BOM，由測試檢查。 / Non-ASCII PowerShell 5.1 script source requires a UTF-8 BOM.

## Linux

保留主機的 `LANG`、`LC_ALL`、`LC_CTYPE`，不自動覆寫語系。文字操作前確認 locale 支援 UTF-8；可用的名稱依主機而異。Shell／sed 不會自動把 Big5、GBK 文件轉成 UTF-8。需要轉換時先保留原檔，確認來源編碼後另產生候選檔並驗證；不要以忽略無效字元的選项覆蓋來源。 / Existing locale variables are preserved. Confirm a supported UTF-8 locale before locale-sensitive text operations. Never discard invalid bytes while overwriting an original file.

## 安裝設定與回復 / Managed configuration and rollback

預設 dotenv 設定與 JSON 政策檔必須是有效 UTF-8，可有 UTF-8 BOM；NUL、不完整／非法 UTF-8 拒絕讀取，不自動猜測或重寫。已明確設定的 legacy dotenv encoding override 保持相容。Windows 安裝器更動前嚴格驗證，保存原始位元組，針對欄位修改時保留 BOM／換行；回復使用原始位元組。Linux 重裝保留 BOM、中文、既有換行與最後換行狀態，使用既有經驗證的備份回復。來源預檢失敗時保留原部署。 / Default dotenv and policy files require valid UTF-8, optionally with BOM. Invalid text fails before rewriting. Installer rollback preserves original bytes; explicit legacy dotenv overrides remain compatible.

6.0.1 預檢跟隨 dotenv/config 真正使用的 CLI 選項，命令列優先於環境值、重複選項採最後有效值；空的 path／encoding 環境值使用原本預設。Windows 程序終止需等到程序及 stdout／stderr 都結束，Audit 的 ACL helper 不探索用戶端模組、不繼承無關秘密；既有 5 秒 Audit 和終止上限保留。 / Validation follows actual CLI precedence/defaults. Windows termination waits for process and pipes; the fixed file Audit ACL helper disables module autoload and excludes unrelated caller environment while retaining existing deadlines.

6.0.2 的 Windows PowerShell Shell 入口使用固定 ASCII 指令接收獨立環境值中的原始來源，執行前清除該值；預設明確載入內建 Management 模組，保留授權的自訂模組路徑、中文／引號／20,000 字元上限與退出碼。檔案仍須明確指定編碼，原生 allowlist 不受此包裝影響，也不略過主機的腳本政策。 / The fixed PowerShell Shell entry receives source independently of native command-line quoting, clears its private value, and explicitly loads the built-in Management module by default. Authorized custom module paths, Unicode, quotes, long source and exit codes remain supported; file encoding and host script policy remain separate.

## 上傳與下載 / File transfer

工具透過 Base64 傳送**原始位元組**，以 SHA-256 核對，不進行文字解碼或轉碼；UTF-8、UTF-8 BOM、UTF-16LE、Big5 與二進位內容都沿用原始資料。檔名、5 MiB、專用目錄、預設停用、不覆寫與 Audit 規則保持不變，詳見 [file transfer guide](file-transfer.md)。 / Base64 transfers preserve bytes, encoding and BOM; existing authorization, directory and size limits still apply.

本功能改善編碼邊界與可辨識錯誤，沒有新增任意文件編輯工具或完整檔案沙箱。外部程式仍可能用錯誤編碼修改文件；禁止宣稱所有 Shell 寫入都能自動保護或回復。 / These changes do not sandbox arbitrary programs or automatically make every file edit safe.
