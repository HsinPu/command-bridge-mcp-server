# 專案工作指南

## 專案概況

CommandBridge MCP 是跨平台的 MCP Server，讓 MCP 用戶端透過本機 stdio 或 Streamable HTTP，在 Linux／Windows 主機執行受政策限制的作業系統指令。

- 技術：TypeScript、Node.js、ES modules、MCP SDK、Express、Zod。
- 2026-09-22 初次檢視時版本為 0.3.0（pre-1.0）；目前版本以 package.json 為準。
- Node.js 需求為 >=20；目前 CI 使用 24.18.0，涵蓋 Ubuntu 與 Windows。
- MCP 工具：command_bridge_get_system_info、command_bridge_run_command、command_bridge_list_audit_events，以及 3.1.0 新增的 command_bridge_upload_file、command_bridge_download_file。
- 預設使用 stdio 與 allowlist 執行模式；HTTP 模式需要至少 32 字元的 Bearer Token。

## 程式結構

| 路徑 | 用途 |
| --- | --- |
| src/index.ts | 啟動入口與傳輸方式選擇 |
| src/server.ts | 建立 MCP Server |
| src/config/env.ts | 環境變數驗證、預設值與設定載入 |
| src/transport/httpTransport.ts | HTTP 路由、Bearer Token 驗證、MCP transport |
| src/tools/commandBridgeTools.ts | MCP 工具註冊、輸入輸出 schema 與錯誤回應 |
| src/services/commandPolicy.ts | Shell、指令白名單與工作目錄政策 |
| src/services/selfProtection.ts | 執行前的直接自改誤操作攔截；不解譯任意 Shell 或提供完整沙箱 |
| src/services/guardedPolicy.ts | guarded 的直接刪除／系統修改誤操作攔截與受限制語法檢查 |
| src/services/commandExecutor.ts | 程序執行、並行數、逾時、輸出限制與 Audit lifecycle |
| src/services/auditLog.ts | Audit 事件、秘密遮罩與平台讀寫實作 |
| src/services/systemInfoService.ts | 主機資訊與有效政策 |
| scripts/linux-systemd/、packaging/systemd/、packaging/linux/ | Linux 安裝、解除安裝、systemd 與 Audit reader |
| scripts/windows/、packaging/windows/ | Windows 安裝、解除安裝、WinSW 與 Event Log 腳本 |
| docs/ | Linux 與 Windows 部署指南 |
| .github/workflows/ci.yml | 跨平台測試與部署資產檢查 |

## 常用指令

```sh
npm ci
npm run build
npm test
npm run dev
npm start
```

- npm test 會先建置，再由 scripts/test.mjs 自動探索 dist/ 內所有 .test.js。
- npm run dev 會先建置以準備 Windows 原生目錄鎖資產，再使用 tsx 執行 src/index.ts；npm start 執行建置後的 dist/index.js。
- 本機設定範本為 .env.example；.env、node_modules/、dist/ 已列入 .gitignore。
- CI 另檢查 Linux Shell 語法、PowerShell 語法、WinSW XML 與 systemd unit。

## Git 提交規則（必須遵守）

- 每次完成一批任何調整，都必須在完成升版、CHANGELOG 與必要驗證後建立 Git commit，不必等待使用者再次要求。此規則包含程式、測試、安裝／部署設定及所有文件修改。
- 提交本批已確認的變更，不將其他來源或尚未完成的變更混入；完成後回報 commit SHA 及驗證結果。若提交受阻，明確說明原因，不宣稱已提交。

## 版本更新規則（必須遵守）

每次完成一批任何調整，都必須在同一批變更中更新版本號，不得沿用修改前的版本。此規則包含 src/、測試程式、安裝／解除安裝腳本、部署設定、建置／CI 設定、依賴更新，以及 AGENTS.md、README、驗證紀錄等文件、註解與排版修改。純文件修改也必須升版，沒有免升版例外。

「一批」指一次交付的完整修改；同一任務內的編輯、除錯與測試修正合併升版一次，不必每次存檔升版。後續獨立交付的任何修改必須再次升版。提交前必須確認該批已同步更新版本與 CHANGELOG。

### 大、中、小版本的判斷

版本格式為 MAJOR.MINOR.PATCH（大版.中版.小版）。先判斷是否破壞相容性，再判斷是否新增功能，其餘使用小版；同一批包含多種類型時，採最高等級。

| 等級 | 何時調整 | 調整方式 | 本專案範例 |
| --- | --- | --- | --- |
| 大版 MAJOR | 既有用戶端、設定或部署方式無法繼續使用，需要使用者遷移 | 大版 +1，中版及小版歸零；例如 1.4.2 → 2.0.0 | 移除／重新命名 MCP 工具或必要回傳欄位、加入必填輸入、移除環境變數且無相容處理、移除平台支援、提高最低 Node.js 版本導致原支援環境不可用 |
| 中版 MINOR | 新增功能且保留既有用法 | 中版 +1，小版歸零；例如 1.4.2 → 1.5.0 | 新增 MCP 工具、新增有相容預設值的選用參數、增加可選傳輸或 Audit 功能 |
| 小版 PATCH | 修復問題、改善效能、內部重構或維護，沒有新增功能或破壞既有有效用法 | 小版 +1；例如 1.4.2 → 1.4.3 | 修復空白根目錄驗證、修正逾時清理、相容的依賴更新、補測試、修正 CI 或安裝腳本 |

- 本專案即使仍為 0.x，也遵守上述明確分級：0.3.0 的修正升為 0.3.1、新功能升為 0.4.0、破壞相容性的修改升為 1.0.0，不以 pre-1.0 為由降低等級。
- 安全修正若只是拒絕原本就不應接受的非法輸入，通常升小版；若使已支援的合法用法失效或要求設定遷移，則升大版。
- 依賴本身升大版不代表本專案一定升大版；以本專案對外行為和支援環境的實際影響判斷。
- 只有文件、註解、排版或工作規則調整，且不影響程式對外行為時，升 PATCH；例如 1.0.1 → 1.0.2。

### 每次升版的具體步驟

1. 讀取 package.json 的目前版本，檢查整批修改的相容性影響，依上表決定新版本。不可只因修改行數少就一律升小版。
2. 同步更新所有代表本專案目前版本的位置：
   - package.json 的 version。
   - package-lock.json 頂層 version 及 packages[""] 的 version；不要批次替換第三方依賴的版本。
   - MCP Server 版本由 scripts/build.mjs 從 package.json 產生，不維護另一個應用版本常數。
   - 安裝器從來源 package.json 取得版本，以完整來源 SHA 區別部署內容，不要求版本等於 tag。
   - README.md、README.zh-TW.md、docs/ 與測試中的目前版本範例。固定 bootstrap 入口不隨版本變動，歷史紀錄與舊版範例保留。
3. 在根目錄 CHANGELOG.md 新增該版本的紀錄（檔案不存在則建立），包含日期、升版等級與理由、具體變更；大版必須寫明不相容之處及使用者如何遷移。
4. 搜尋舊版本字串，逐筆確認是否仍有需要同步的目前版本參照；不要改動 Node.js、WinSW 等獨立元件版本，除非本次確實更新該元件。
5. 執行 npm test 及與修改相關的平台／腳本檢查，確認版本一致性。若環境限制導致無法驗證，明確記錄未執行項目與原因，不得宣稱通過。
6. 交付說明必須寫出「舊版本 → 新版本」、選擇此等級的具體理由及驗證結果。更新版本號不代表已發布；Git tag、Release 或套件發布依使用者要求執行，尚未發布的下載連結需標明狀態。

## README 撰寫規範（使用者已確認）

2026-09-22 使用者確認 commit 6115f3d 的中英文 README 呈現方式。後續更新以這種面向 GitHub 訪客的完整專案介紹為基準，隨實際功能調整內容。

- README.md 使用英文，README.zh-TW.md 使用繁體中文，提供互相切換的連結；功能、限制、版本與操作指令必須同步。
- README 應包含清楚的專案定位、狀態徽章、導覽、使用情境、主要功能、運作架構圖、安裝需求、Codex 連線方式、MCP 工具與使用範例、安全邊界、Audit Log、文件及問題回報入口。
- 「只提供一鍵安裝和一鍵解除安裝」是指安裝／卸載的操作入口保持簡單，不是刪除其他專案介紹。不要再次把 README 縮減成只有下載指令的短文件。
- Windows 與 Linux 各提供一行可複製的安裝指令及一行解除安裝指令；主流程不要求使用者先 clone、安裝 Git／Node.js，或手動填入 --codex-url。
- 說明安裝後會啟動服務、設定開機啟動、自動帶入適用的 IP，並印出含 Token 的 Codex 連線設定。區分新安裝與既有設定保留、區網位址與 loopback 回退，避免宣稱所有環境都能直接遠端連線。
- 在 README 保留必要的權限、網路、Token 和資料保留說明；詳細設定、疑難排解、升級回復與完整清除方式放在 docs/ 平台指南，從 README 連結過去。
- 功能描述必須符合實作，不將白名單宣稱為完整沙箱、絕對防止危險操作或刪除，也不將 Audit Log 宣稱為不可竄改。自動 IP 的 HTTP 連線只適用可信任區網／VPN；HTTPS 與防火牆不會自動建立。
- README 使用 main 上的固定 bootstrap 入口；bootstrap 只能依 install-channel/channel.txt 下載同一完整 SHA 的來源，禁止退回浮動 main。僅通過跨平台 CI 與服務驗證的 main push 可更新 channel；發布須序列化並防止舊執行結果覆寫新來源。不要求發布 tag，保留既有 v0.4.0 tag。
- 純介紹或排版修改時，仍須升 PATCH 並更新 CHANGELOG；確認四個一行指令沒有意外變動、相對文件連結有效、中英文內容一致，並執行 git diff --check。不需為排版新增程式測試。

## 修改時應維持的行為

- 4.2.0 起支援 `--version`／`-V`，必須在載入設定、SDK、Audit 與 listener 前回應。Linux `/usr/local/bin/command-bridge` 的版本查詢跟隨啟用 release；4.3.0 另支援 update／check；安裝不可覆寫同名外部入口，需標籤檢查、驗證、失敗回復，卸載只移除管理的連結。Windows 安裝根目錄的 `command-bridge.cmd` 使用內附 Runtime 與選定 release，不修改 PATH。npm 保留長名稱並提供短名稱；無參數啟動 MCP 的既有行為不變。版本查詢不代表服務健康或 GitHub 最新版本。

- 4.1.16 起，程序執行結束即釋放指令名額；終結 Audit 成功前不得回傳輸出。共用 Audit 讀寫的排隊及 I/O 回應等待最多 5 秒，未完成操作上限 64；失敗後停止新作業，排除儲存故障並重啟才恢復。逾時不代表底層 I/O 已取消，必須追蹤實際操作，禁止啟動過期排隊寫入或重複終結事件；停機仍在 15 秒上限內等待。Readiness 需限時並共用尚未結束的檢查。不能宣稱此修正已確認現場 Docker 卡住的原因。

- 4.1.1 起，guarded 需辨識 curl／wget 黏合輸出參數及 PowerShell Path／LiteralPath／Destination／FilePath 命名與冒號形式，不依參數順序猜測目的地。無法確定的參數明確拒絕；系統來源複製到一般工作目錄應可通過 guarded 路徑檢查。回歸測試使用無破壞性程式／不存在的程式路徑，不能以實際寫入系統位置驗證拒絕。

- 4.1.0 新增可選 guarded 模式，allowlist 預設與 unrestricted 原有行為保持不變。guarded 攔截可辨識的刪除、系統位置寫入及常見系統管理修改；保留其他一般指令與既有 sudo。不能宣稱會解譯任意程式／外部腳本，或保證不刪檔／不改系統。語法不支援須明確拒絕；guarded 錯誤附規則及 Audit ID。Linux --guarded 與 --unrestricted 互斥；Windows -ExecutionMode 明確選擇才切換既有模式，保存完整回復備份。詳見 docs/guarded-mode.md。

- 4.0.0 起，指令執行前檢查可辨識的直接自改操作，在建立子程序前拒絕並記錄 attempted／blocked、SELF_MODIFICATION_BLOCKED。allowlist、guarded 與 unrestricted 均適用；保留原本 sudo，不新增提權代理或唯讀隔離。攔截是防止誤操作，不是安全沙箱；不可宣稱能阻止腳本、變數、程式內部或外部 root 服務的間接修改。詳見 docs/self-protection.md。

- 3.1.0 檔案傳輸授權獨立於 allowlist／guarded／unrestricted，預設皆關閉。只支援受保護傳輸目錄內的安全單層檔名、一般檔案與最多 5 MiB，不覆寫、不執行内容、不透過 Shell／sudo／網址抓取。Linux 固定目錄 descriptor；Windows 驗證 ACL 並持有原生目錄鎖，無法保護時拒絕。詳見 docs/file-transfer.md。
- 檔案 Audit 沿用 schemaVersion 1 的選用 fileTransfer metadata，不記錄內容。初始失敗不操作；終結失敗不回傳下載內容，上傳已發布時明確回報可能存在，不宣稱回復。逾時後實際 I/O 未結束前不得釋放名額。

- 維持 Linux／Windows 相容性；涉及 Shell、路徑、程序終止或服務部署時需分別考慮兩個平台。
- 預設採 allowlist；不要在未獲使用者要求時放寬為 unrestricted。
- 每次指令嘗試先寫入 attempted，再寫入唯一一筆 blocked、completed 或 failed 終結事件。
- 首次 Audit 寫入失敗時不啟動指令；終結 Audit 寫入失敗時不回傳已擷取的輸出。
- Audit 不應包含 stdout、stderr 或未遮罩秘密；修改遮罩與執行流程時應檢查相關測試。
- HTTP listener 本身不提供 TLS；自動 IP 連線用於可信任區網／VPN，也可透過私有 HTTPS 路由存取受驗證端點。
- 更動使用方式或部署行為時，同步檢查 README.md、README.zh-TW.md 與相關 docs/ 文件。

## Linux 服務與安裝路徑命名（2.0.0 起）

- Linux 的正式 systemd 單元為 `command-bridge.service`；主要部署、設定與工作資料目錄分別為 `/opt/command-bridge`、`/etc/command-bridge`、`/var/lib/command-bridge`。預設服務帳號為 `command-bridge`；明確使用 `--run-as-installer` 時，服務改以原始 sudo 登入者帳號執行，檔案 Audit／狀態使用 `/var/lib/command-bridge-installer`。後續文件、測試與操作指令應以這些名稱為準。
- 安裝者帳號模式不應自動新增一般 sudo 授權；只有 `--unrestricted` 明確啟用時才允許自由 Shell 指令，需用 `sudo -n` 依主機既有免密政策執行。預設 allowlist、Bearer Token 驗證與 Audit 先寫入後執行的規則保持不變。模式切換失敗須回復舊設定、服務及 Audit reader；卸載與 purge 不得刪除登入者帳號或其 home。
- 2.2.1 起，`--run-as-installer` 不建立專用 `command-bridge` 使用者，只保留政策讀取群組。新服務通過真實 MCP／Audit 並完成切換後，偵測舊版本留下的本機系統帳號，驗證 UID、home、nologin Shell、群組與無活動程序後才移除。不得強制殺程序、刪除同名一般登入帳號、使用 `userdel -r` 或遞迴變更工作資料所有權。保留群組原 GID；清理失敗須回報且保留已驗證的新服務，切換驗證失敗則保留舊帳號供回復。預設專用帳號模式仍建立所需使用者；測試須涵蓋兩種模式。
- 縮短名稱只涵蓋 Linux 服務與主機上的安裝配置；GitHub 倉庫及固定 bootstrap 網址、npm 套件名稱、Windows 的 `CommandBridgeMCP` 服務與路徑，以及三個 MCP 工具名稱維持原樣，不應為了統一字面名稱而連帶改動。
- 從 1.x 升級時，安裝器須先驗證舊設定，再切換服務；保留 Bearer Token、政策與工作資料，只調整既有設定中由安裝器管理的 `COMMAND_BRIDGE_POLICY_FILE` 與 `COMMAND_BRIDGE_ALLOWED_ROOTS` 路徑。成功後舊目錄名稱保留為指向新目錄的相容連結，舊 systemd 單元移除；失敗則恢復原目錄、設定、版本與舊服務。不能把相容連結誤認為仍有舊服務在執行。
- 以後修改 Linux 安裝／卸載或路徑時，須檢查新安裝、1.x 遷移、失敗回復、資料與 Token 保留、真實 MCP／Audit 驗證，以及一般解除安裝和 `--purge`。僅驗證 systemd 啟用與服務重啟時，不宣稱已完成實際主機重開機測試。
- 2.0.2 起，Linux 部署不得保留 `/tmp` 的 SELinux context；須依主機政策修復並驗證新建及重用的 Runtime／程式、設定、服務與 Audit 資產標籤。2.0.3 起需相容 Oracle Linux 8.10 不支援 `restorecon -x` 的情況，以 `find -P -xdev` 控制遍歷範圍。Enforcing／Permissive 缺工具或驗證失敗時停止啟用，回復後也須驗證才重啟。不得關閉 SELinux、自動放寬政策或遞迴重標使用者工作資料；WSL Disabled 與模擬測試不代表 Oracle Linux Enforcing 驗證通過。

## Linux 安裝模式選擇（3.0.0 起）

- Linux 每次安裝／重裝依本次參數寫入執行模式：未加 `--guarded` 或 `--unrestricted` 為 `allowlist`；4.1.0 起加 `--guarded` 為 `guarded`；明確搭配 `--run-as-installer --unrestricted` 才為 `unrestricted`。既有或繼承環境的執行模式不得覆蓋本次選擇。其他設定與 Token 保留，切換驗證失敗須回復原設定和服務。
- 4.1.2 起中英文 README 主指令明確選擇 guarded（Linux --guarded、Windows -ExecutionMode guarded）；未指定模式的程式／安裝器預設維持原規則；文件須提醒需自由 Shell 的舊用戶每次重裝都要明確加參數。測試涵蓋新裝、雙向切換、重裝、缺失模式欄位、設定保留與失敗回復。

## 初步檢查紀錄（2026-09-22）

初次觀察已在 1.0.0 實作中處理；以下不代表完整安全稽核認證。

1. **已修正：空白根目錄。** 在 resolve() 前拒絕空項目，執行時以 realpath 檢查 symlink／junction 越界，附行為測試。
2. **已替換：Shell 白名單執行。** allowlist 僅接受字面參數與精確 argv 政策；原生程式直接啟動，PowerShell Cmdlet 透過固定包裝程式。自訂政策只允許受管理的原生執行檔，政策檔及其所在目錄不可讓服務帳號寫入。unrestricted 必須明確啟用，不因政策錯誤自動切換。

後續完成修正或驗證時，更新以上紀錄，避免把歷史觀察當作目前狀態。

## 管理命令更新（4.3.0 起）

- 服務安裝的 `command-bridge update`／`update --check` 使用本機保存的 bootstrap，固定已通過 CI 的完整 SHA。check 不變更部署；同 SHA 不重建或重啟，不以版本號相同取代 SHA 核對。npm 安裝仍透過 npm 更新。
- update 與一鍵重裝區分：完整保留設定、模式及服務帳號，禁止附帶模式、網路與帳號變更參數；Linux 安裝者帳號必須經原登入者 sudo 更新。變更需要管理員終端，不自動提權；可辨識的 MCP 自我更新要阻擋，Token 只在明確要求設定輸出時顯示。
- 沿用安裝鎖、實際服務／MCP／Audit 驗證與回復，鎖內核對先前讀到的來源 SHA。Windows 安裝、更新及卸載共用 mutex。更新資產需位於受保護部署，暫存清理及失敗回復都必須測試。

- 4.3.1 起，建置後 npm prune 必須使用 --no-save 保留來源 manifests；不要為重裝放寬 clean-source 驗證。拋棄式 CI 可明確準備安全 CLI 父目錄，但正式安裝仍拒絕可由非管理員寫入的目錄。鎖回歸測試用獨立名稱，需驗證持有正式部署鎖時仍可建置測試。

- 4.3.2 起，故障測試不得用整個替換啟動入口而破壞版本查詢。保留正式 CLI 引數處理，在指定部署 SHA 的服務啟動階段注入；來源建置及版本查詢不得產生啟動證據。缺少證據一律拒絕視為回復測試成功。
