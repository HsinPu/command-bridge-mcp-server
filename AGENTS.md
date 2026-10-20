# 專案工作指南

## 任務與知識維護

- 每次任務開始先讀取根目錄 `AGENTS.md` 與 `MEMORY.md`；缺少時依實際專案建立。
- `AGENTS.md` 保存架構、開發規範與工作流程；`MEMORY.md` 保存已驗證的問題、解法、決策與限制。操作說明放 `docs/`，逐版變更放 `CHANGELOG.md`，詳細驗證結果放 `docs/validation-status.md`。
- 完成任務前檢查兩份指引；有新證據或過時內容才更新，合併重複資訊，不把推論寫成已確認根因。版本、分支、CI 與 channel 屬時效資訊，使用前重新核對。
- 不記錄 Token、秘密、原始環境或未遮罩的私人日誌。測試案例與故障注入只放專用測試檔／拋棄式 fixture，不放 README 或正式程式的測試分支。
- 本專案沿用既有的「每批調整皆升版」規則，包含純文件與記憶檔案；此專案規則優先於一般純文件免升版原則。

## 專案概況與架構

CommandBridge MCP 讓用戶端透過本機 stdio 或 Streamable HTTP，在 Linux／Windows 執行受政策限制的指令、有限背景工作及檔案傳輸。

- 技術：TypeScript、Node.js >=20、ES modules、MCP SDK、Express、Zod；CI 固定 Node.js 24.18.0，涵蓋 Ubuntu 與 Windows。
- 應用版本以 `package.json` 為唯一來源，由 `scripts/build.mjs` 產生 Server 版本；不要維護另一份應用版本常數。歷史版本與已驗證發布見 CHANGELOG／MEMORY。
- 程式預設 stdio、allowlist；HTTP 必須有至少 32 字元的 Bearer Token，保留 Host 驗證。HTTP 本身不提供 TLS，也不自動設定防火牆。
- MCP 工具共 13 個，以 `src/tools/commandBridgeTools.ts` 為準：
  - 系統／同步／稽核：`command_bridge_get_system_info`、`command_bridge_run_command`、`command_bridge_list_audit_events`。
  - 傳輸：`command_bridge_upload_file`、`command_bridge_download_file`。
  - 更新／診斷：`command_bridge_update`、`command_bridge_get_update_status`、`command_bridge_get_diagnostics`。
  - 背景工作：`command_bridge_start_job`、`command_bridge_get_job`、`command_bridge_list_jobs`、`command_bridge_read_job_output`、`command_bridge_cancel_job`。

| 路徑 | 責任 |
| --- | --- |
| `src/index.ts`、`src/server.ts` | 啟動、傳輸選擇與建立 MCP Server |
| `src/config/env.ts`、`src/transport/httpTransport.ts` | 設定驗證、預設值、HTTP／Host／Bearer 驗證與 readiness |
| `src/tools/commandBridgeTools.ts` | 工具註冊、schema、錯誤格式 |
| `src/cli/` | 本機 info/setup/access、連線描述、服務查詢與安裝設定遷移 |
| `src/services/commandPolicy.ts`、`commandProfiles.ts` | 字面參數政策、固定程式、Shell 與真實 cwd 檢查 |
| `src/services/selfProtection.ts`、`guardedPolicy.ts` | 可辨識的直接自改、刪除及系統修改誤操作攔截 |
| `src/services/commandExecutor.ts`、`commandTermination.ts` | 共用執行名額、逾時、輸出、程序終止、隔離與安全證據 |
| `src/services/backgroundJobs.ts`、`jobStore.ts` | 背景佇列、去重、狀態與受保護保存 |
| `src/services/auditLog.ts`、`boundedAuditLog.ts`、`fileAuditLog.ts` | Audit lifecycle、遮罩、操作預算與平台後端 |
| `src/services/diagnosticsService.ts`、`diagnosticTypes.ts`、`diagnosticProbe.ts` | 不依賴 Audit 成功的有界診斷 |
| `src/services/fileTransferService.ts`、`temporaryAccess.ts`、`managedUpdate.ts` | 私有檔案傳輸、短期授權與固定更新協調 |
| `scripts/linux-systemd/`、`packaging/systemd/`、`packaging/linux/` | Linux 安裝、卸載、回復、systemd 與固定 helper |
| `scripts/windows/`、`packaging/windows/` | Windows 安裝、卸載、回復、WinSW 與 Event Log |
| `scripts/tests/`、平台的 `tests/`、`src/**/*.test.ts` | 獨立測試、私有 fixture 與整合驗證 |
| `docs/`、`.github/workflows/ci.yml` | 操作／驗證紀錄、跨平台與服務發布門檻 |

## 開發與驗證流程

```sh
npm ci
npm run build
npm test
npm run dev
npm start
```

- `npm test` 先建置，再由 `scripts/test.mjs` 探索 `dist/` 全部 `.test.js`，以 `--test-concurrency=1` 逐檔執行。不得依 CPU 數量放大並行或提供略過來源測試的安裝選項。
- `npm run dev` 的 predev 會建置 Windows 原生目錄鎖資產，再由 tsx 執行來源；`npm start` 執行 `dist/index.js`。`.env.example` 是設定範本；`.env`、`node_modules/`、`dist/` 與日誌不提交。
- 先完成編輯與升版，再執行完整測試；測試執行期間不要改動共用的來源、package 或 dist，以免混用版本。
- 程式／測試／部署調整執行 `npm test` 與相關平台檢查。純文件調整驗證版本一致性、連結、未變動的安裝指令與 `git diff --check`，不新增形式化測試；涉及版本建置時可重跑既有測試。
- Shell 腳本逐檔執行語法檢查，另檢查固定 Linux launcher；PowerShell 以原生 5.1 parser 檢查，驗證 WinSW XML 與 systemd unit。遵守 `.gitattributes`：TS／JSON／Markdown／Shell 為 LF；正式 PS1 保持 ASCII，非 ASCII 須 UTF-8 BOM。
- 正常程序測試同時檢查 `ok`、`exitCode`、`timedOut`、`truncated` 與固定結果；`finally` 關閉 executor。故障只輸出固定階段、旗標、耗時與分類，避免洩漏命令、秘密或私人路徑。
- 回復驗證須證明指定部署 SHA 的新服務已啟動／切換，且指定故障與階段證據同時存在，再驗證舊 SHA、服務、ready、真實 MCP／Audit、Token 與資料回復；提前下載／建置失敗不能算回復成功。故障只修改拋棄式來源，來源建置與版本查詢不得觸發。
- 完成報告分開列出本機、WSL、hosted CI、channel 與現場驗證。服務啟用／重啟不等於真實重開機；Ubuntu／WSL 不等於 Oracle Linux SELinux Enforcing 或正式 Docker build 驗證。

## Git 與版本管理（必須遵守）

- 每批任何調整都必須升版、更新 CHANGELOG、完成必要驗證後自動建立本機 commit，無須再次詢問。只提交本次已確認變更，不混入其他來源的修改。
- **不得自動 push**；只有使用者明確要求時才 push。若要求監控 CI，須追到該完整 SHA 的結果；失敗依證據修正、重新驗證與提交，不放寬發布條件。
- Commit message 包含本批版本與具體摘要。回報 commit SHA、驗證結果及是否已 push；受阻不得宣稱完成。
- 一批指一次完整交付，編輯、除錯與本批測試修正合併升版一次；後續獨立交付再升版。

| 等級 | 判斷 | 具體調整 |
| --- | --- | --- |
| MAJOR | 破壞有效的既有介面／設定／平台，需要使用者遷移；例如移除工具、必要欄位或無相容處理的設定 | 大版 +1，其餘歸零：1.4.2 → 2.0.0；CHANGELOG 必須寫遷移方法 |
| MINOR | 新增向下相容功能；例如新增工具、有相容預設值的選用設定 | 中版 +1，PATCH 歸零：1.4.2 → 1.5.0 |
| PATCH | 修復、效能、內部重構、相容維護或純文件／記憶／註解／排版 | 小版 +1：1.4.2 → 1.4.3 |

先判斷破壞相容性，再判斷新增功能，其餘 PATCH；混合變更取最高等級，0.x 同樣適用。拒絕原本非法輸入通常 PATCH，但拒絕已支援的合法用法須 MAJOR；依賴套件自身升大版不代表本專案必須升大版。

每批升版步驟：

1. 讀取 `package.json`，依對外影響決定新版本，不以行數判斷。
2. 同步 package 的 version、lockfile 頂層及 `packages[""]` version；禁止全檔取代造成第三方依賴、tarball 或 integrity 異動。
3. 同步中英文 README 徽章、平台指南、目前版本標題／範例；歷史紀錄、引進版本與 Node／WinSW 獨立版本不改。建置版本仍由 package 產生。
4. CHANGELOG 新增日期、等級理由與具體內容；搜尋舊版本字串逐項確認，驗證、檢查 diff 後 commit。
5. 回報「舊版本 → 新版本」、等級理由與驗證。升版／commit 不代表推送、tag、Release 或 channel 已發布。

## 權限、指令與程序生命週期

- allowlist 僅接受「指令名＋字面參數」，固定原生程式與精確 argv 政策，不交給 Shell 二次解析；PowerShell Cmdlet 走固定包裝與序列化參數。自訂政策具 schemaVersion，拒絕缺失／重複／無效政策、Shell／腳本宿主目標；`COMMAND_BRIDGE_ALLOWED_COMMANDS` 只是啟用清單，仍須有效政策。政策及父目錄不得讓服務帳號寫入，不因政策錯誤轉 unrestricted。
- cwd 空白項目在 resolve 前拒絕，再以 realpath 處理 symlink／junction 越界；這不是檔案系統沙箱。
- guarded 攔截可辨識的直接刪除與系統修改，保留其他指令及既有 sudo；curl／wget 黏合輸出參數、PowerShell 命名／冒號路徑須正確辨識，無法判定則拒絕。不宣稱能檢查任意腳本、程式內部或完整 root sudo。
- 所有模式在 attempted Audit 後、一般政策／子程序前套用直接自改及管理命令攔截；錯誤保留規則與 Audit ID。不得新增通用提權代理，也不得把誤操作防護宣稱為安全沙箱。見 [自我保護](docs/self-protection.md) 與 [guarded](docs/guarded-mode.md)。
- stdout／stderr 各自嚴格串流解碼；預設 UTF-8，選用 utf16le／big5／gbk／gb18030。正常結束時無效／不完整輸出不回傳；逾時或截斷不補替代字元。檔案編碼獨立，不猜測、全面轉碼或用亂碼／截斷內容覆寫文件。Windows cmd 與 PowerShell 固定入口／環境邊界見 [文字編碼](docs/text-encoding.md)。
- 同步預設 15 秒、上限 300 秒；請求超限依同步契約限制。預設 stdout＋stderr 共用 50,000 字元，超限仍觸發終止；長工作改用背景 API，不自動重跑或只調高輸出上限。
- Linux 先對程序群組送 SIGTERM，2 秒後仍需要時送 SIGKILL；Windows 等待 `taskkill /T /F` 並核對結果。現有 5 秒終止確認預算不因 CI 耗時延長；程序退出、兩個串流關閉及 Linux 群組消失都須確認，不能只看 leader 或終止工具回傳。
- 單一工作終止失敗不得設定服務 `stopping`。未確認工作占用隔離名額；僅確認完成後回收，Linux 查詢只有 ESRCH 代表不存在，EPERM／EACCES 不算。不得憑保存 PID 重送訊號或宣稱 root 後代／Docker daemon 已停止。
- 隔離使診斷呈現 degraded、ready 失敗；剩餘名額仍可使用，滿額回傳 `COMMAND_TERMINATION_UNCONFIRMED` 與恢復條件。服務 shutdown 才進 stopping，拒絕新作業、終止程序、完成可寫入的 Audit，總等待仍限 15 秒。
- 已確認程序結束即釋放一般名額，不因終結 Audit 排隊繼續占用；未確認則轉隔離保留。服務允許接收與當下有空名額是不同條件，不得因暫時滿額把背景佇列當停機取消。
- 每個請求與名額各完成／釋放一次；保留最初終止觸發原因、有效限制、實際 timedOut／truncated／cancelled、計數、時間、階段與分類錯誤。failed Audit 不可用預設 false 掩蓋執行狀態；日誌不得輸出 raw cause、Token、命令、cwd、環境或輸出內容。

## Audit、readiness、診斷與傳輸

- 每次嘗試先成功寫 attempted，再允許作業；唯一終結為 blocked／completed／failed。終結 Audit 失敗不得回傳已擷取輸出，未完成實際 I/O 要持續追蹤，不得重複終結或重複啟動過期排隊工作。
- `COMMAND_BRIDGE_AUDIT_TIMEOUT_MS` 預設 30000，只接受 1000–60000 整數毫秒；舊設定缺欄位採預設，明確值保留。排隊＋後端共享一次預算，helper 取剩餘時間，未完成操作上限 64；真正故障後拒絕新作業，排除問題並重啟才恢復，不自動解除故障。
- Audit 保留共用介面、schemaVersion 1 與遮罩；JSON 固定以 schemaVersion／event 起始，選用 job／fileTransfer metadata 放後面，保持原生 reader 可讀。Audit 不含 stdout／stderr 或未遮罩秘密；list 預設 50、上限 1000，與診斷的 100 筆上限不同。
- backend 為 auto／journal／eventlog／file；HTTP auto 使用平台原生日誌，stdio auto 使用使用者私有 JSONL。安裝預設為 Linux 專用帳號 journal、安裝者帳號 file、Windows eventlog。檔案每份 10 MiB、保留 5 份；Windows 腳本依應用位置解析，不依 cwd。
- `/health` 僅存活；Bearer 保護的 `/ready` 回應限 5 秒，共用尚未完成檢查、短暫快取，不因回應逾時提前停用尚未達 Audit 預算的後端。安裝成功須真實 MCP `hostname` 與對應 Audit lifecycle，不能只看 health。
- 診斷不依賴 Audit 成功，限固定 schema、5 秒／64 KiB、2 秒完成快取、最近最多 100 筆記憶體摘要。不得回傳命令、cwd、stdout／stderr、Token、完整內部路徑或 raw error；重啟摘要清空，不代替歷史 Audit。底層未結束時共用實際工作，不能反覆新增 helper。
- 僅 Audit 故障且其他依賴全已確認時允許唯讀診斷啟動，ready 仍失敗、新作業仍拒絕；不得當成安裝成功。Linux 診斷 reader 使用 root 管理的固定無參數入口及 numeric UID／NOSETENV 精確 sudo 規則，Windows 使用固定受保護腳本，不增加一般提權。見 [診斷指南](docs/diagnostics.md)。
- 檔案傳輸在所有模式均獨立預設關閉；限私有目錄的安全單層檔名、一般檔案、5 MiB，不覆寫、不執行、不經 Shell／sudo／URL 抓取。Linux 固定 directory descriptor；Windows ACL 與原生目錄鎖，不能保護就拒絕。
- 傳輸實際 I/O 限 15 秒，與 Audit 等待分開。逾時未結束不得釋放名額；下載終結失敗不回傳內容，上傳已發布時說明可能存在，不能假稱已回復。見 [傳輸指南](docs/file-transfer.md)。

## 背景工作與設定遷移

- 五個背景工具保留同步介面，共用執行身分、sudo、並行名額及政策；啟動前重驗有效模式、cwd 與自我保護，排隊後授權到期／模式變更不得沿用舊授權。
- 預設 30 分鐘、上限 60 分鐘，管理員可設定至一天；背景請求超出上限明確拒絕。UUID requestId 只在紀錄保存期間去重；斷線不取消已接受工作，重啟未完成工作標記 interrupted，不重播、不憑保存 PID 殺程序。
- attempted／唯一終結 Audit 與安全保存成功前不公開 stdout／stderr；執行中僅 metadata。輸出 5 Mi 字元／10 MiB 序列化上限，超限持續排空、不因輸出量終止。總配額 100 MiB、保留 24 小時、分頁小於 64 KiB。共用 Token 不提供對話隔離。
- 6.5.0 起受管理安裝／更新補齊缺少的 jobs 啟用、絕對路徑及時限，保留明確 true／false、既有自訂值與無關位元組；npm／開發環境缺旗標仍停用。啟用不能只有旗標，還須建立／驗證可用私有儲存與標籤，遷移可重複並先備份、失敗回復。
- Linux 固定 `/var/lib/command-bridge-jobs` 父目錄 root:root 0755、數值 UID 子目錄 0700；Windows `ProgramData\CommandBridgeMCP\jobs` 僅 SYSTEM／Administrators／LocalService。拒絕連結、不安全所有權／ACL 或其他實例紀錄，不遞迴變更工作資料權限；自訂目錄由管理員準備。
- 移除舊專用帳號前，只將其 jobs 葉目錄 metadata 封存為 root 私有，避免 UID 重用；一般卸載保留紀錄，purge 先預檢。MCP 更新遇到未完成工作或隔離名額拒絕；管理員更新／重啟仍可中斷。見 [背景工作指南](docs/background-jobs.md)。

## 管理命令與臨時授權

- `--version`／`-V` 在載入設定、SDK、Audit 或 listener 前回應；Linux `/usr/local/bin/command-bridge` 跟隨啟用 release，Windows 使用安裝根目錄 `command-bridge.cmd` 與內附 Runtime，不改 PATH。版本不代表健康或 GitHub 最新版。
- `info [--json]`／`setup` 限主機終端，不啟動 MCP、Audit、GitHub 或寫設定。`setup --show-token` 須明確要求且核對 root／提升管理員，不自動提權；不可讀設定時回固定的部分摘要與權限原因，不假稱設定不存在。
- `client-setup.json` schemaVersion 1、不含 Token、服務唯讀；安裝與 CLI 共用解析。重裝／更新保留名稱與 HTTPS URL，只有明確參數才修改；缺舊描述須提示無法還原舊自訂值，格式錯誤不得默默重設。固定連線名預設 `cb_<hostname>`。
- MCP 各模式拒絕可辨識的直接 info/setup/access 管理命令、常見字面 sudo／Shell 包裝及固定 helper；保留版本、update check 與固定 MCP 更新工具。CLI 查詢限 5 秒／64 KiB，部署切換要求重試；見 [本機管理指南](docs/local-administration.md)。
- `access open/status/close` 僅管理員終端，預設 5、範圍 1–60 整數分鐘；不改永久模式、不加 sudo 或開啟傳輸。root／管理員原子發布的唯讀 lease 綁定服務啟動 UUID，到期、關閉、重啟、異常或時鐘回退恢復基準，已啟動程序沿用原時限。
- 開啟需先 Audit；讀 lease 限 5 秒且共用實際工作，逾時不得延遲授權，Audit 等待後再次確認到期。HTTP /access 只有受驗證狀態，不能修改；CLI 使用本機挑戰／HMAC 簽署驗證，不外送原始 Token、拒絕非本機位址。見 [臨時授權](docs/temporary-access.md)。
- CLI `update`／`update --check` 使用本機受保護 bootstrap 和 CI 完整 SHA，同 SHA 不重建／重啟；npm 仍由 npm 更新。update 保留設定、模式、身分與連線，禁止附帶切換參數；安裝者帳號模式須原登入者 sudo，不自動提權。
- 固定 MCP 更新在受管理服務預設開啟，由 Linux root oneshot／Windows SYSTEM 工作執行；只接受固定 request，不接受任意來源、Shell、版本或安裝參數。狀態／Audit 在部署外，接受任務不代表成功，須核對終結狀態及來源 SHA。npm／stdio 不建立特權 worker；見 [MCP 更新](docs/mcp-update.md)。

## 受管理安裝、遷移與回復

- README 的固定 main bootstrap 只讀 `install-channel/channel.txt`，整次安裝鎖定同一完整 SHA；無資訊、格式錯誤或下載失敗停止，不回退浮動 main，不要求 tag，保留既有 v0.4.0。記錄應用版本、SHA 與 Runtime，以版本＋SHA 區分部署。
- Node／WinSW 版本及 checksum 獨立固定，仍現場建置與測試。`npm prune --omit=dev --no-save` 不得改來源 manifests；安裝／更新／卸載共享平台鎖，鎖內再次核對來源身分。
- 備份須先完成內容及 metadata 驗證才標可回復；分清原本存在、備份完整、實際改動，不能以備份缺失推定應刪原檔。切換後通過 ready、真實 MCP／Audit、診斷與 CLI，才清除升級備份。
- 回復逐項驗證位元組、所有權／ACL／SELinux、layout、CLI、helper 與服務；不完整不重啟、不刪必要資料，保存於私有 recovery 並拒絕後續略過。Bash 條件呼叫不能吞掉失敗，Windows 不可把 stderr 一律當非零退出。
- 解除安裝優先使用安全且相容的本機卸載器；缺完整 layout／recovery 預檢或資產時，在任何服務變更前使用同一 CI SHA 的完整後備，後備失敗保留原部署。
- 保留既有 Token、連線及無關設定；自動 IP 僅新裝或明確 refresh-network 重選，失敗精確回復。Linux 重裝模式依當次參數，CLI update 則保留模式，兩者不可混淆。

### Linux 固定配置與權限

| 項目 | 位置／名稱 |
| --- | --- |
| 服務 | `command-bridge.service` |
| 程式／Runtime／release | `/usr/local/lib/command-bridge` |
| CLI | `/usr/local/bin/command-bridge` |
| 設定 | `/etc/command-bridge` |
| 工作資料 | `/var/lib/command-bridge` |
| 安裝者狀態與檔案 Audit | `/var/lib/command-bridge-installer` |
| jobs／更新／回復紀錄 | `/var/lib/command-bridge-jobs`、`/var/lib/command-bridge-update`、`/var/lib/command-bridge-recovery` |

- 預設專用 `command-bridge` 帳號；`--run-as-installer` 使用驗證過的原 sudo 登入者，只保留政策讀取群組，不新增一般 sudo 授權，`sudo -n` 依主機原政策。專用更新／診斷／Audit reader 僅限固定、最小範圍授權。
- README 主指令明確 `--run-as-installer --guarded`；安裝器未指定模式為 allowlist，`--guarded` 與 `--unrestricted` 互斥，unrestricted 需安裝者模式。繼承環境或舊模式不可覆寫本次選擇；切換失敗回復原服務／設定。
- 不刪登入帳號或 home，不用 `userdel -r`。新服務驗證成功後，才依系統 UID、home、nologin、群組與無活動程序等條件移除舊專用帳號；保留 GID、不強殺程序、不遞迴 chown。清理失敗須明確回報。
- 新舊根目錄、父目錄、連結實際目標及 `.migration-backup` 先完整預檢；拒絕可由非管理員修改、掛載越界或多份獨立部署，固定服務入口精確辨識，不接受額外 argv／環境／Shell 包裝／重複 ExecStart。
- 遷移至新檔案系統先暫存複製，舊部署留到新服務驗證通過。成功後 `/opt/command-bridge`、`/opt/command-bridge-mcp-server` 及受管理程式備份／相容連結須完全移除，不留程式別名；設定與資料的 `/etc`／`/var/lib` 相容連結依既有規則保留。
- 1.x 遷移只調整管理的政策／工作根路徑與經驗證的新預設，保留其他設定、Token、資料；舊 MCP worker 不可跨舊實體根搬遷，須在服務變更前拒絕，由管理員終端完成一次遷移。
- 只有首次新根啟動失敗、無啟用指標、無已安裝／註冊的新舊主服務與 updater，且所有預檢通過時，才可重用符合 SHA／版本／Runtime 的檔案。not-found 失敗快取不等於活動服務；不猜測修復不完整的活動部署。
- 新建／重用 Runtime、程式、設定及 helper 修復並驗證主機 SELinux 標籤，不留 `/tmp` context。Oracle 8.10 不支援 `restorecon -x`，使用 `find -P -xdev`；Enforcing／Permissive 缺工具或驗證失敗不得啟用，不關閉 SELinux、不新增 allow rule、不遞迴重標使用者資料。
- 主服務、更新 worker／finalizer 以受驗證的固定 `/usr/bin/env --` 進入絕對內附 Node，沿用主機既有 transition；驗證 launcher 原始／解析路徑、管理員所有權與既有標籤，不自動重標系統 launcher。Unix UID 不等於 SSH SELinux domain。
- 一般卸載先預檢全部新舊根與備份，移除可驗證程式、單元與 helper 授權，保留設定、Token、log、工作／jobs／更新／回復紀錄及 client 描述。purge 先安全預檢，仍不刪登入帳號／home。詳見 [Linux 指南](docs/linux-systemd.md)。

### Windows 相容與回復

- 服務與固定路徑保留 `CommandBridgeMCP`，以 LocalService 執行；不用 Linux 短名連帶改 GitHub／npm／Windows／工具名。
- PowerShell 5.1 StrictMode、原生退出碼、固定 Management 模組、過濾環境及子程序原始輸出須保持相容；原生 stderr 可為正常診斷，僅呼叫期間調整偏好並 finally 還原，真正失敗仍拒絕。
- 受保護檔案原子替換用 `[NullString]::Value`；從快照建立新 ACL descriptor 並明確寫 Access／Owner／Group，不重用 dirty flags 已清除的物件。回復保留 BOM／換行／原始 bytes／ACL，失敗不得重啟。詳見 [Windows 指南](docs/windows-service.md) 與 MEMORY。

## README 與發布驗收

- 沿用已確認的完整 GitHub 專案介紹：定位、徽章、導覽、使用情境、功能、架構圖、需求、連線、工具範例、安全邊界、Audit、文件與 Issues；不縮成只有下載指令。
- 英文 `README.md`／繁中 `README.zh-TW.md` 互相連結，功能、版本與指令同步；兩平台各一行安裝、一行卸載，主流程不要求先 clone、裝 Git／Node 或填 codex-url。主指令明確 guarded，需自由 Shell 的用戶重裝要明確選參數。
- 說明服務啟動／開機啟用、自動 IP、loopback 回退、既有設定保留，以及含 Token 的 Codex setup。HTTPS、防火牆及遠端可達性不自動保證；詳細遷移／回復／purge 放平台指南。
- Linux sudo 範例使用 `/usr/local/bin/command-bridge` 完整路徑，避免 `secure_path` 缺少 local bin；不修改主機 sudo PATH。Codex setup 的 `tool_timeout_sec=480` 涵蓋標準同步與 Audit 預算，客製長指令需另外調整用戶端。
- 發布需要 Ubuntu／Windows 一般測試、兩平台真實 service smoke、Linux layout gate 全過；只有 main push 能序列化更新 channel，PR 無寫入權限，舊執行不可覆寫較新驗證來源。
- service-smoke 總 job 預算 75 分鐘，Linux layout 45 分鐘；這是完整整合流程預算，不改正式指令／Audit／終止時限、不略過任何檢查。CI 完成後核對完整來源 SHA、版本、main 與 channel，不能只看 workflow 名稱或舊成功結果。
