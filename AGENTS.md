# 專案工作指南

## 專案概況

CommandBridge MCP 是跨平台的 MCP Server，讓 MCP 用戶端透過本機 stdio 或 Streamable HTTP，在 Linux／Windows 主機執行受政策限制的作業系統指令。

- 技術：TypeScript、Node.js、ES modules、MCP SDK、Express、Zod。
- 2026-09-22 初次檢視時版本為 0.3.0（pre-1.0）；目前版本以 package.json 為準。
- Node.js 需求為 >=20；目前 CI 使用 24.18.0，涵蓋 Ubuntu 與 Windows。
- MCP 工具：command_bridge_get_system_info、command_bridge_run_command、command_bridge_list_audit_events。
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

- npm test 會先建置，再執行 package.json 明列的 Node.js test 檔案。新增測試檔時需確認是否納入此清單。
- npm run dev 使用 tsx 執行 src/index.ts；npm start 執行建置後的 dist/index.js。
- 本機設定範本為 .env.example；.env、node_modules/、dist/ 已列入 .gitignore。
- CI 另檢查 Linux Shell 語法、PowerShell 語法、WinSW XML 與 systemd unit。

## 版本更新規則（必須遵守）

每次完成一批程式碼修改，都必須在同一批變更中新增版本號，不得沿用修改前的版本。此規則包含 src/、測試程式、安裝／解除安裝腳本、部署設定、建置／CI 設定及依賴更新。純文件、註解或排版修改且不影響執行行為時，可不升版。

「一批」指一次交付的完整修改；同一任務內的編輯、除錯與測試修正合併升版一次，不必每次存檔升版。後續獨立交付的程式碼修改必須再次升版。

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

### 每次升版的具體步驟

1. 讀取 package.json 的目前版本，檢查整批修改的相容性影響，依上表決定新版本。不可只因修改行數少就一律升小版。
2. 同步更新所有代表本專案目前版本的位置：
   - package.json 的 version。
   - package-lock.json 頂層 version 及 packages[""] 的 version；不要批次替換第三方依賴的版本。
   - src/server.ts 的 MCP Server version。
   - scripts/linux-systemd/install.sh 的 SOURCE_REF（v 前綴）。
   - scripts/windows/install.ps1 的 PackageVersion 與 SourceRef（後者含 v 前綴）。
   - README.md、README.zh-TW.md、docs/ 與測試中指向本次版本的安裝範例、斷言及下載連結。歷史紀錄與明確的舊版範例保留原版本。
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
- 下載網址須與目標版本一致，未發布 tag 時明確標示不可直接使用；不把推送 main 當成發布 tag。
- 純介紹或排版修改時，確認四個一行指令沒有意外變動、相對文件連結有效、中英文內容一致，並執行 git diff --check。純文件修改不需升版，也不需為排版新增程式測試。

## 修改時應維持的行為

- 維持 Linux／Windows 相容性；涉及 Shell、路徑、程序終止或服務部署時需分別考慮兩個平台。
- 預設採 allowlist；不要在未獲使用者要求時放寬為 unrestricted。
- 每次指令嘗試先寫入 attempted，再寫入唯一一筆 blocked、completed 或 failed 終結事件。
- 首次 Audit 寫入失敗時不啟動指令；終結 Audit 寫入失敗時不回傳已擷取的輸出。
- Audit 不應包含 stdout、stderr 或未遮罩秘密；修改遮罩與執行流程時應檢查相關測試。
- HTTP listener 本身不提供 TLS；自動 IP 連線用於可信任區網／VPN，也可透過私有 HTTPS 路由存取受驗證端點。
- 更動使用方式或部署行為時，同步檢查 README.md、README.zh-TW.md 與相關 docs/ 文件。

## 初步檢查紀錄（2026-09-22）

這次僅閱讀程式碼與文件，沒有安裝依賴或執行測試；以下不能視為完整安全稽核結果。

1. **待修正：允許根目錄的空白項目檢查順序。** src/config/env.ts 先將 COMMAND_BRIDGE_ALLOWED_ROOTS 各項目 trim 後傳給 resolve()，才檢查結果是否為空字串。空白項目會被轉為目前工作目錄，使後續空字串檢查無法攔截。應在 resolve() 前驗證原始項目，並補上相關測試。
2. **待調查：Shell 白名單解析邊界。** src/services/commandPolicy.ts 以正規表示式攔截部分控制語法、比對起始指令名稱，再由 Shell 執行完整字串。需要檢查不同 Shell 的解析差異與潛在繞過方式；目前尚未驗證具體繞過案例，不應將其描述成已確認漏洞。

後續完成修正或驗證時，更新以上紀錄，避免把歷史觀察當作目前狀態。
