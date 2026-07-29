<h1 align="center">CommandBridge MCP</h1>

<p align="center">
  <strong>透過 Codex 與其他 MCP 用戶端，以政策控制方式執行 Linux 與 Windows 指令。</strong>
</p>

<p align="center">
  <a href="https://github.com/HsinPu/command-bridge-mcp-server/actions/workflows/ci.yml"><img src="https://github.com/HsinPu/command-bridge-mcp-server/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI 狀態"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/protocol-MCP-7f52ff" alt="Model Context Protocol"></a>
  <a href="#支援主機"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-2563EB" alt="Linux 與 Windows"></a>
  <a href="#專案狀態"><img src="https://img.shields.io/badge/status-pre--1.0-F59E0B" alt="Pre-1.0"></a>
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> ·
  <a href="#連線-codex">連線 Codex</a> ·
  <a href="#mcp-工具">MCP 工具</a> ·
  <a href="docs/linux-systemd.md">Linux 指南</a> ·
  <a href="docs/windows-service.md">Windows 指南</a> ·
  <a href="SECURITY.md">安全政策</a> ·
  <a href="README.md">English</a>
</p>

> [!CAUTION]
> CommandBridge 能執行作業系統指令。請先使用 <code>allowlist</code> 模式、專用低權限服務帳號，並把遠端 HTTP 存取限制在私有且具驗證的網路。

## 專案狀態

CommandBridge MCP 目前為 pre-1.0，適合受控環境使用。下方直接從 GitHub 下載的安裝命令固定使用 <code>v0.3.0</code>；請在該 tag 發布後才使用。你現在可直接從已 clone 的專案安裝。

## 為什麼使用 CommandBridge？

CommandBridge 是一個跨平台的 [Model Context Protocol](https://modelcontextprotocol.io/) Server，可在無法或不希望使用 SSH 的情況下，讓 MCP 用戶端檢查主機並執行受政策限制的指令。

| 需求 | CommandBridge 的做法 |
|---|---|
| 無法使用 SSH | 使用本機 <code>stdio</code> 或私有 Streamable HTTP。 |
| 希望先安全地開始維運 | 預設使用 <code>allowlist</code>，只允許已設定的簡單診斷指令。 |
| 同時管理 Linux 與 Windows | 使用相同 MCP 工具，搭配各平台適合的 Shell。 |
| 需要可追蹤的操作 | 每次指令嘗試都會留下遮罩後的 Audit lifecycle。 |
| 需要受控的遠端存取 | HTTP 需要 Bearer Token，並放在私有 HTTPS 路由之後。 |

## 重點功能

- **跨平台** — Linux 支援 <code>bash</code>、<code>sh</code> 與選用的 <code>pwsh</code>；Windows 支援 PowerShell 與 <code>cmd.exe</code>。
- **政策優先** — 可限制 Shell、指令名稱、工作目錄、逾時、輸出大小、繼承環境變數與同時執行數量。
- **Audit Trail** — 每次執行記錄 <code>attempted</code> 與一筆最終 <code>blocked</code>、<code>completed</code> 或 <code>failed</code> 事件，不保存指令輸出或未遮罩秘密。
- **部署資產** — 提供 Linux systemd 安裝器，以及以 WinSW 和 <code>LocalService</code> 執行的 x64 Windows Service 安裝器。

## 快速開始

### Linux systemd

在支援 systemd 的 glibc Linux 主機，從已 clone 的專案執行：

~~~bash
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
cd command-bridge-mcp-server
sudo bash scripts/linux-systemd/install.sh \
  --print-codex-setup \
  --codex-url "https://command-bridge.example.com/mcp"
~~~

安裝器會下載固定版本的 Node.js Runtime、建置並測試程式碼、建立低權限 <code>command-bridge</code> 帳號、安裝到 <code>/opt</code>、啟用服務、驗證 <code>/health</code>，並印出可直接複製的 Codex 設定區塊。

確認服務：

~~~bash
sudo systemctl status command-bridge-mcp-server --no-pager
curl -fsS http://127.0.0.1:8800/health
~~~

<details>
<summary>不 clone，直接安裝已發布的 <code>v0.3.0</code> 版本</summary>

~~~bash
installer=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/install.sh -o "$installer"
sudo bash "$installer" --print-codex-setup --codex-url "https://command-bridge.example.com/mcp"
rm -f "$installer"
~~~

</details>

前置條件、升級、回復、Audit access 與安全解除安裝請參考 [Linux systemd 指南](docs/linux-systemd.md)。

> [!NOTE]
> Synology DSM 並非 systemd 主機。請使用 Container Manager 或 DSM 專用套件。

### Windows Service

在提升權限的 PowerShell，於已 clone 的專案中執行：

~~~powershell
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
Set-Location command-bridge-mcp-server
.\scripts\windows\install.ps1 -PrintCodexSetup -CodexUrl "https://command-bridge.example.com/mcp"
~~~

x64 安裝器會驗證 Node.js <code>v24.18.0</code> 與 WinSW <code>v2.12.0</code>、執行測試、建立 <code>CommandBridgeMCP</code> Application Event Log source，並以 <code>NT AUTHORITY\LocalService</code> 啟動服務。

主機需求、Event Viewer 查詢、回復與解除安裝請參考 [Windows Service 指南](docs/windows-service.md)。

### 本機開發

~~~bash
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
cd command-bridge-mcp-server
npm ci
cp .env.example .env
npm run build
npm start
~~~

預設傳輸方式為 <code>stdio</code>。如需 Streamable HTTP，設定 <code>COMMAND_BRIDGE_TRANSPORT=http</code> 並提供至少 32 個字元的 Bearer Token。

## 連線 Codex

若 Codex 位於另一台機器，請用 Tailscale Serve、Cloudflare Tunnel 或具驗證的 Reverse Proxy，將 loopback listener 放到私有 HTTPS 路徑之後。

> [!WARNING]
> CommandBridge 內建 HTTP listener 不提供 TLS。請勿直接將 <code>8800</code> port 公開到網際網路。

建議安裝時使用 <code>--print-codex-setup</code>，然後把標記區塊貼到受信任的 Codex 工作。這會將 Bearer Token 存在環境變數，而不是寫進 <code>config.toml</code>。

若要手動設定，先將 Token 存成 Codex 用戶端上的 <code>COMMAND_BRIDGE_BEARER_TOKEN</code>，再加入：

~~~toml
[mcp_servers.command_bridge]
enabled = true
url = "https://command-bridge.example.com/mcp"
bearer_token_env_var = "COMMAND_BRIDGE_BEARER_TOKEN"
startup_timeout_sec = 20.0
tool_timeout_sec = 60.0
~~~

重新啟動 Codex，開啟 <code>/mcp</code>，確認 <code>command_bridge</code> 已連線。

## 運作方式

~~~mermaid
flowchart LR
    client["Codex 或 MCP 用戶端"]
    transport{"傳輸方式"}
    stdio["本機 stdio"]
    http["私有 Streamable HTTP"]
    auth["Bearer Token 與 Host 驗證"]
    policy["指令政策與限制"]
    executor["指令執行器"]
    audit["遮罩後的 Audit Log"]
    host["Linux 或 Windows 主機"]

    client --> transport
    transport --> stdio --> policy
    transport --> http --> auth --> policy
    policy --> executor --> host
    executor --> audit
~~~

每台已部署主機會執行一個 MCP Endpoint。未來的 Gateway 模式會協調多台由 Agent 主動向外連線的主機。

## MCP 工具

| 工具 | 用途 | 安全行為 |
|---|---|---|
| <code>command_bridge_get_system_info</code> | 回傳主機資訊與有效的 CommandBridge 政策。 | 唯讀且具冪等性。 |
| <code>command_bridge_run_command</code> | 使用指定 Shell 與工作目錄執行一個指令。 | 強制套用設定的政策；在 <code>unrestricted</code> 模式可能改變主機狀態。 |
| <code>command_bridge_list_audit_events</code> | 取得最近的遮罩後 Audit events。 | 唯讀、具冪等性；預設 50 筆，上限 100 筆。 |

指令請求範例：

~~~json
{
  "command": "hostname",
  "shell": "bash",
  "cwd": "/var/lib/command-bridge-mcp-server/work",
  "timeoutMs": 15000
}
~~~

## Command Audit Log

每次 <code>command_bridge_run_command</code> 都會在程序啟動前寫入 <code>attempted</code>，並在結束後寫入唯一一筆 <code>blocked</code>、<code>completed</code> 或 <code>failed</code>。

- 第一次 Audit 寫入失敗時，CommandBridge 不會啟動指令。
- 最終 Audit 寫入失敗時，CommandBridge 不會回傳已擷取的指令輸出。
- 每筆事件包含 Audit ID、時間、階段、遮罩後指令、Shell、工作目錄、執行模式、來源、exit code、耗時、timeout／truncation 與錯誤代碼。
- Audit 絕不包含 <code>stdout</code>、<code>stderr</code>、Bearer Token、環境變數值或原始未遮罩指令。

Linux 會把單行 JSON 寫入 service journal；Windows 會寫入 Provider 為 <code>CommandBridgeMCP</code> 的 Application Event Log。保存期限由主機控制。這是可追蹤的維運紀錄，不是具簽章、雜湊鏈或不可竄改保證的合規稽核系統。

用唯讀工具查詢近期紀錄：

~~~json
{ "limit": 50 }
~~~

## 解除安裝

Linux 標準解除安裝會移除服務、應用程式、Audit reader 與其受限 sudoers 規則，但保留設定、工作資料與低權限帳號，讓未來可以重新安裝。

~~~bash
uninstaller=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "$uninstaller"
sudo bash "$uninstaller" --yes
rm -f "$uninstaller"
~~~

> [!CAUTION]
> 完整清除會永久刪除 Bearer Token、設定、工作資料與服務帳號。

~~~bash
uninstaller=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "$uninstaller"
sudo bash "$uninstaller" --purge --yes
rm -f "$uninstaller"
~~~

Windows 請在提升權限的 PowerShell 執行 <code>.\scripts\windows\uninstall.ps1 -Yes</code>。加上 <code>-Purge</code> 可刪除 <code>%ProgramData%\CommandBridgeMCP</code>；使用 <code>-DryRun</code> 可先預覽。

## 設定與執行政策

手動開發可複製 [.env.example](.env.example)。最重要的設定如下：

| 變數 | 預設值 | 用途 |
|---|---|---|
| <code>COMMAND_BRIDGE_TRANSPORT</code> | <code>stdio</code> | 選擇 <code>stdio</code> 或 <code>http</code>。 |
| <code>COMMAND_BRIDGE_BEARER_TOKEN</code> | 無 | HTTP 模式必填；至少 32 個字元。 |
| <code>COMMAND_BRIDGE_EXECUTION_MODE</code> | <code>allowlist</code> | 選擇 <code>allowlist</code> 或 <code>unrestricted</code>。 |
| <code>COMMAND_BRIDGE_ALLOWED_SHELLS</code> | 作業系統預設 | 以逗號分隔的允許 Shell。 |
| <code>COMMAND_BRIDGE_ALLOWED_COMMANDS</code> | 作業系統預設 | allowlist 模式允許的指令。 |
| <code>COMMAND_BRIDGE_ALLOWED_ROOTS</code> | 啟動目錄 | 允許的工作目錄根路徑。 |
| <code>COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS</code> | <code>15000</code> | 預設指令逾時。 |
| <code>COMMAND_BRIDGE_MAX_OUTPUT_CHARS</code> | <code>50000</code> | stdout 與 stderr 合計上限。 |
| <code>COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS</code> | <code>2</code> | 每個 Process 的指令同時執行數。 |

<code>allowlist</code> 模式會拒絕 pipe、redirect、串接、command substitution 與換行。使用 <code>unrestricted</code> 前，請先確認服務帳號在作業系統層級的權限。

## 支援主機

| 環境 | 支援狀態 |
|---|---|
| 手動開發 | Node.js 20 或更新版本，以及 npm |
| Linux Runtime | <code>bash</code>、<code>sh</code>，以及選用的 PowerShell 7 <code>pwsh</code> |
| Linux 安裝器 | systemd、glibc、<code>x86_64</code> 或 <code>arm64</code>、Linux 4.18+、<code>/opt</code> 至少 400 MB |
| Windows Runtime | Windows PowerShell 與 <code>cmd.exe</code> |
| Windows 安裝器 | Windows 10/11 或 Windows Server x64、提升權限 PowerShell、內附 Node.js 與 WinSW |
| Alpine 與 musl Linux | systemd 安裝器不支援 |

## 安全模型

應用程式政策只是其中一層防護。

- 除非明確需要 unrestricted 執行，否則維持 <code>allowlist</code> 模式。
- 用專用、非系統管理員帳號執行 CommandBridge。
- 每台主機使用不同的 Bearer Token；若懷疑外洩，立即輪替。
- HTTP 必須維持私有，或放在具驗證的 TLS 後方。
- 限制允許的工作目錄與繼承環境變數。
- 不要把密碼、API Key 或 Private Key 放入指令參數。
- 不要將 Linux 服務帳號加入 <code>sudo</code>、<code>docker</code>、<code>adm</code> 或 <code>systemd-journal</code> 群組。安裝器只會為 root-owned Audit reader 加入一條精確、無參數的 sudoers 規則。

部署前請閱讀完整的 [安全政策](SECURITY.md)。弱點請透過私密的 [GitHub Security Advisory](https://github.com/HsinPu/command-bridge-mcp-server/security/advisories/new) 回報，不要開公開 Issue。

## 文件

| 主題 | 文件 |
|---|---|
| Linux 安裝、升級、Audit access 與解除安裝 | [Linux systemd 指南](docs/linux-systemd.md) |
| Windows Service、Event Log 與解除安裝 | [Windows Service 指南](docs/windows-service.md) |
| 手動設定參考 | [.env.example](.env.example) |
| 安全邊界與回報方式 | [SECURITY.md](SECURITY.md) |

## 開發

~~~bash
npm ci
npm test
~~~

<code>npm test</code> 會編譯 TypeScript，並執行指令政策、Audit lifecycle／遮罩、MCP 工具、Linux 資產、解除安裝資產與 Windows 安裝器資產測試。

若 Windows PowerShell 的執行政策阻擋 <code>npm.ps1</code>，請改用 <code>npm.cmd</code>。

~~~text
src/                         應用程式原始碼
docs/                        部署指南
packaging/linux/             固定的 Linux Audit reader
packaging/systemd/           Linux systemd unit
packaging/windows/           WinSW Service 定義
scripts/linux-systemd/       Linux 安裝器與解除安裝器
scripts/windows/             Windows 安裝器、解除安裝器與 Event Log helpers
~~~

## 開發藍圖

- 支援輪詢與取消的背景工作
- Agent 主動向外連線的中央 Gateway
- 遠端 MCP 用戶端的 OAuth 2.1
- 已簽署的主機註冊與每台主機授權範圍
- 支援離線安裝的已簽署 Linux 預先建置 Release Artifact

## 參與貢獻

歡迎提出 Issue 與 Pull Request。

1. 大幅變更行為或安全邊界前，先建立 [Issue](https://github.com/HsinPu/command-bridge-mcp-server/issues)。
2. 建立聚焦的 Branch。
3. 執行 <code>npm test</code>。
4. 開啟 Pull Request，說明動機、行為變更與驗證證據。

## 專案連結

- [GitHub Actions](https://github.com/HsinPu/command-bridge-mcp-server/actions)
- [Issues](https://github.com/HsinPu/command-bridge-mcp-server/issues)
- [Releases 與 tags](https://github.com/HsinPu/command-bridge-mcp-server/tags)
- [Security advisories](https://github.com/HsinPu/command-bridge-mcp-server/security/advisories)
