# 專案記憶

更新日期：2026-10-20。這裡保存經過確認、可重用的經驗；開發規則以 [AGENTS.md](AGENTS.md) 為準，詳細逐版驗證見 [驗證紀錄](docs/validation-status.md)。CI、來源 SHA 與安裝頻道屬時間點紀錄，後續使用前須重查。

## 文件與交付決策

- AGENTS 放架構與必須維持的行為，MEMORY 放問題／解法／原因及證據邊界；避免再把完整歷史修正清單堆進工作指引。
- 本專案既有規則要求所有交付批次升版，純文件／本記憶修改也為 PATCH；一般「純文件免升版」在此不適用。只改 package／lock 根版本，不改第三方依賴版本。
- 完成驗證後自動本機 commit，message 記錄版本；使用者明確要求才 push。commit、push、CI 通過與安裝頻道發布分開回報。
- 使用者於 2026-10-20 明確要求重寫並精簡 README；中英文首頁保留專案定位、核心功能與操作入口，完整設定／管理／遷移改連到 docs，避免再次擴寫成操作手冊。安裝／卸載各平台維持一行；測試案例只放專用測試／fixture，驗證結果放驗證紀錄，不放 README 或正式程式故障注入分支。
- README 依現行使用流程整理，不堆疊舊版修正歷史；程式預設 allowlist 與 README guarded、Linux 安裝者帳號與專用帳號、原始碼版本與 install-channel 發布須分開說明。同步檢查連結的設定範本／安全文件，避免殘留舊政策路徑或錯誤的 jobs 遷移說法；未提供 LICENSE 時不得自行宣告授權。

## 已確認的發布基準

2026-10-20 重新查詢 GitHub 確認：

| 項目 | 已驗證結果 |
| --- | --- |
| 已發布版本 | 6.5.3 |
| GitHub main 與 channel 的完整應用來源 SHA | `f5b3feb6cc7b4e271c71280bdfa53a3806d80925` |
| CI | [#95／39357789856](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/39357789856)，completed／success |
| 六項工作 | Ubuntu／Windows 一般測試、兩平台 service smoke、Linux layout smoke、publish-channel 全部 success |
| 安裝頻道 | [channel.txt](https://github.com/HsinPu/command-bridge-mcp-server/blob/install-channel/channel.txt)，第一行完整來源 SHA、第二行 6.5.3 |

這是 6.5.3 的發布證據，不代表後續文件版本已 push／經過 CI。channel 分支自己的 commit 與檔案內應用來源 SHA 是不同用途，不能混比。實際 Oracle Linux Enforcing、主機重開機、26pv 更新或正式 20 分鐘 Docker build／daemon 取消，仍未由這些結果驗證。

## 終止失敗與長工作（6.5.0）

- 6.4.1 診斷基準為 `14280baa38c3fe9988183014b39a7bc1a6ffc94c`。現場曾在 Docker build 提前收到 `COMMAND_TERMINATION_FAILED`，隨後服務仍存活但停在 stopping、拒絕新指令。
- 已確認的程式原因：同步輸出超過共用上限會終止；原失敗處理把單次終止異常設成整個服務 stopping；原 failed Audit 可能用預設 false 遺失真正 timedOut／truncated。
- **未確認當次觸發原因**：輸出超限只是合理推論，不能排除外部取消／其他原因，也不能以舊 failed Audit 的 false 排除逾時或截斷。當次底層是 EPERM、群組期限或其他錯誤，缺少原始證據。
- 修正位於 `src/services/commandExecutor.ts`／`commandTermination.ts`：shutdown 與單次失敗分開；未確認工作保留隔離名額，剩餘容量可繼續，全部占滿回明確未確認錯誤。程序退出、串流關閉及 Linux 群組消失才回收，不從保存 PID 再送訊號。
- `process.kill(-pid, 0)` 只有 ESRCH 可確認不存在；EPERM／EACCES 是未知，不能釋放名額。不能用 leader 退出或 taskkill 成功回傳取代完整確認，也不能先 destroy 擷取串流再宣稱它們正常關閉。
- 隔離期間診斷呈 degraded、ready 失敗；MCP 更新拒絕。自然結束且確認後回收容量，但不把先前 failed／unknown 歷史改成成功。沒有新增 sudo killer、一般免密 sudo 或將服務改成 root。
- 已確認退出即釋放一般名額，終結 Audit 等待不占用；未知工作轉隔離保留。服務接收狀態與瞬時容量分開判斷，避免把等待空位的背景佇列誤當 stopping 而取消。
- 保存第一個 timeout／output-limit／client-cancel／service-shutdown／output-decode-failure 原因、有效限制、輸出計數、實際旗標／耗時與固定階段／錯誤分類，記錄安全 journal 證據及 failed Audit；不輸出命令、cwd、環境、內容或 raw exception。
- 同步 50,000 字元預設上限仍終止；背景輸出超限截斷保存、持續排空且工作繼續。長 build 使用正式背景 API，不自動轉背景重跑以免重複副作用。
- Linux 私有測試曾以有限 root 子程序及降權父程序實測 EPERM／自然結束回收，不建立帳號或 sudoers。這不能證明實際 sudo、Oracle SELinux 或 Docker daemon 已可取消；root 後代仍可能需要管理員介入。

## 背景工作設定遷移（6.5.0）

- `src/cli/jobConfigurationMigration.ts` 是受管理安裝／更新共用遷移器；runtime 的 npm／開發預設仍停用，不能把兩種預設混寫。
- 缺少 jobs 設定時補啟用、固定絕對 root、1800000／3600000 毫秒。明確 false 保留原始 bytes；true／既有自訂 root／時限／無關設定保留，啟用時驗證絕對路徑、1000–86400000 整數與 max >= default。
- Linux 固定 root 為 `/var/lib/command-bridge-jobs`，Windows 為絕對 ProgramData/CommandBridgeMCP/jobs；安裝器還要準備權限／ACL／SELinux，不能只補 true。沿用原始設定／metadata 備份與回復，exclusive 私有 candidate 發布，重複遷移不追加重複欄位。
- Linux root:root 0755 父目錄、服務 numeric UID 的 0700 葉目錄；換帳號用不同 UID 葉目錄，不遞迴 chown 舊資料。刪舊專用帳號前將舊葉目錄 metadata 封存為 root 私有，以防 UID 重用；自訂位置由管理員準備。
- **dotenv 不是 JSON**：Windows 路徑不能用 JSON.stringify 當 dotenv quoting，反斜線／換行可能不同義。遷移器採字面單引號，必要時使用可接受的替代引用，保留 BOM、LF／CRLF 及原始設定內容；不要以 Shell source 解讀設定。
- **ESM 的入口可經 symlink**：`import.meta.url` 是實際模組位置，`argv[1]` 可能是連結；入口判斷先安全 realpath，不能只比原始字串，否則安裝器呼叫可能無聲未執行。
- 安裝器私有 fixture 需要真實編譯後遷移 helper、Runtime 與 ESM package 說明。僅測卸載的 fixture 不應平白要求 Node；不要為修 fixture 放寬正式安裝預檢或略過來源測試。

## 設定遷移驗證與 CI 預算（6.5.1–6.5.2）

- CI [39199964697](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/39199964697) 兩平台一般測試通過，但 layout 的 dedicated／terminal-migration 在 line 144 失敗：新服務已切換成功，舊斷言卻要求設定 hash 完全不變，與預期追加四個 jobs 預設衝突。
- 6.5.1（`7eac4d69066a49cfc699c97126d3927bd0817826`）加入獨立 `scripts/tests/verify-legacy-jobs-migration.mjs`，先驗證「所有原始 bytes＋僅四個精確預設」才建立遷移後 hash 基準；不能直接重設 hash 或忽略差異。原先回復 bytes 斷言及後續更新／卸載保留驗證不變。
- 該 oracle 的專用測試在 `src/legacyJobsMigration.test.ts`；BOM、LF／CRLF 及 Token／模式／錯誤值／漏欄位／無關新增都須精確驗證。快照私有，失敗只輸出固定分類。
- CI 39199964697 的兩 service 工作在 45 分鐘被取消；不是已證實的斷言失敗，取消前來源摘要 fail=0、真實服務驗證仍成功進行。CI [39201494450](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/39201494450) 的 layout 修正已通過，Linux service 仍碰到總預算。
- 前次成功 6.4.1 CI 38525077448：Linux service 約 42.8 分、Windows 約 38.4 分。6.5.2 只把 service-smoke **整個 job** 預算 45 → 75 分鐘；Linux layout 仍 45 分。沒有改指令／Audit／終止預算、沒有少跑任何驗證或放寬 channel 依賴；之後 CI #94 六項全過。
- 原則：先分辨 assertion failure、取消與總工作逾時，查實際階段／歷史耗時；CI 總預算與正式服務時限分開。每次新交付仍以自己的完整 SHA 驗證，不引用舊綠燈代替新結果。

## Linux 佈署與現場經驗

- 新程式根是 `/usr/local/lib/command-bridge`，CLI `/usr/local/bin/command-bridge`，服務 `command-bridge.service`。成功遷移後兩個舊 `/opt/command-bridge*` 固定程式目錄及相容連結應不存在；一般卸載只保留設定／資料，不保留程式碼。
- 一鍵重裝依這次模式旗標寫入，README 主指令為 installer-account＋guarded；管理命令 update 保留模式。不要把重裝誤當純更新，也不要因既有 unrestricted 而忽略這次 guarded 選擇。
- sudo `secure_path` 可能不含 `/usr/local/bin`，即使安裝成功，`sudo command-bridge` 也找不到。文件使用 `sudo /usr/local/bin/command-bridge ...`，不修改主機 sudo PATH。
- SELinux Enforcing 曾確認 Node 帶 user_tmp_t，init_t 執行遭拒絕；部署必須依 host policy 修復／驗證標籤，不關閉 SELinux。Oracle Linux 8.10 不支援 restorecon -x，使用 find -P -xdev 限定遍歷。
- 即使 UID 相同，SSH 登入與 systemd 的 SELinux domain 不一定相同；固定 `/usr/bin/env -- <內附 Node>` 服務入口沿用主機既有 transition，系統 launcher 要先驗證。WSL Disabled 測試不能宣稱 Oracle Enforcing 通過。
- 遷移／回復須驗證原路徑祖先、實際目標、所有權、掛載、SHA／版本／Runtime 與 service 指標。不能把缺資產當成安全缺失而略過，不完整活動部署不猜測修復。
- 備份與回復分開追蹤「原本存在／備份完成／實際改動」；Bash 在條件函式內可能抑制 errexit，每個回復步驟須明確核對。回復不完整保留私有 recovery、拒絕重啟，暫存清理不可刪掉必要資料。
- 本機 health=200、listener 存在仍不證明外部可達；曾由 firewalld public zone 未開 8800 導致連線無 HTTP 回應。HTTP／HTTPS 與 TCP port 可達性分開診斷，不以協定猜測原因；目前安裝不自動開防火牆或 TLS。

## Windows 相容性教訓

- PowerShell 5.1 StrictMode 不能依賴未初始化變數、與內建重名變數或舊 LASTEXITCODE。原生 stderr 常是正常進度／診斷；以真正退出碼判斷，只在原生呼叫期間調整偏好，finally 還原並傳遞實際失敗。
- `File.Replace` 的空備份路徑使用 `[NullString]::Value`；PowerShell 5.1 的 $null 可能轉成空字串。ACL 每次從快照建立新 descriptor 並寫 Access／Owner／Group，不能重用 dirty flags 已清除的 .NET 物件，否則內容已換但 ACL 未更新。
- 設定／client 描述的備份與回復保留原始 bytes、BOM／換行與 ACL，同檔案系統原子發布；鎖定檔或不完整回復必須拒絕重啟。原始 private UTF-8／BOM UTF-16LE 日誌不公開，只輸出固定結果與有界摘要。
- PowerShell 原始指令經私有子程序環境傳到固定 ASCII 入口，使用前清除內部鍵（忽略大小寫），固定內建模組邊界。cmd 的 UTF-8 wrapper 不套用到原生 allowlist argv。
- 正常 PowerShell 程序測試需同時設定 defaultTimeoutMs、maxTimeoutMs 與請求預算，否則請求提高仍可能被舊上限截斷；專門短逾時／取消測試保留。測試慢不是全面延長正式時限的理由。

## Audit 與驗證邊界

- Audit list 預設 50、上限 **1000**（`src/services/auditLog.ts`）；diagnostics 只保留最近 **100** 筆記憶體摘要，兩者不能混用。早期 100 筆 Audit 上限已過時。
- Audit 操作預設 **30 秒**、可設 1–60 秒，單一預算涵蓋排隊／helper；早期固定 5 秒已過時。ready／diagnostics 回應 5 秒與實際 Audit I/O 不同，回應逾時不代表底層工作已停止。
- Audit 事件 JSON 前綴的 schemaVersion／event 必須固定；6.4.1 曾修正 metadata 排前導致實際 journal reader 排除背景事件。不要以記憶體 mock 通過推定原生日誌整合可用。
- 終結 Audit 失敗仍不回傳命令／下載輸出；診斷不依賴 Audit，但只回安全 metadata，不提供原始命令、輸出或完整路徑。CI 日誌提到錯誤碼可能只是成功測試標題，不能據此宣稱實際 Audit 故障。
- 完整測試期間不再改 package／來源／dist：先前曾因混用舊建置與新 package 造成版本斷言誤敗。穩定內容後再跑，分清本機平台跳過與真正失敗。
- 既有 npm prune fixture 曾碰到 15 秒逾時；本次未改程式或時限，單獨重驗約 2.4 秒通過，完整重跑也通過該項。這確認可重驗通過，未證明當時系統資源根因；初次失敗與完整重驗結果都要保留，不能只報單項綠燈。
- 測試通過、服務重啟、自動啟動設定、實際重開機、Oracle SELinux、正式長 build 及 daemon 端取消，各需獨立證據。沒有證據的項目明確標未驗證，不擴大宣稱。
