param(
    [string]$Root = "",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Protected = @(
    ".git",
    ".update",
    ".update-backup",
    "data",
    "models",
    "node",
    "launcher/config.json",
    "launcher/launcher.log",
    "comfyui-gateway/data",
    "comfyui-gateway/node_modules",
    "comfyui-gateway/resources/bundled"
)

$ManifestUrls = @(
    "https://www.modelscope.cn/datasets/shensanshu/ComfyUI-Local-Infinite-Canvas/resolve/master/update.json",
    "https://raw.githubusercontent.com/1314521gjy/ComfyUI-Local-Infinite-Canvas/main/update.json"
)

# 离线包优先：脚本同目录放 manifest.json + 补丁文件时完全不联网。
# manifest.json 形如 { "version": "v0.21.19", "patch": { "file": "v0.21.19.zip", "size": 123, "sha256": "..." } }
$localManifest = $null
$localPatchPath = ""
$localManifestPath = Join-Path $PSScriptRoot "manifest.json"
if (Test-Path -LiteralPath $localManifestPath) {
    try {
        $candidate = Get-Content -LiteralPath $localManifestPath -Raw | ConvertFrom-Json
        $candidateFile = [string]$candidate.patch.file
        if ($candidate.version -and $candidate.patch -and $candidateFile) {
            $candidatePath = Join-Path $PSScriptRoot $candidateFile
            if (Test-Path -LiteralPath $candidatePath) {
                $localManifest = $candidate
                $localPatchPath = (Get-Item -LiteralPath $candidatePath).FullName
            }
        }
    } catch {
        Write-Host "本地清单读取失败，改用在线清单（$($_.Exception.Message)）" -ForegroundColor DarkYellow
    }
}

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Test-AppRoot([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        $full = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    } catch {
        return $false
    }
    return (Test-Path -LiteralPath (Join-Path $full "VERSION")) -and
        (Test-Path -LiteralPath (Join-Path $full "comfyui-gateway\src\server.js")) -and
        (Test-Path -LiteralPath (Join-Path $full "start-local.bat"))
}

function Resolve-AppRoot([string]$Hint) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $candidates.Add($Hint) }
    if ($PSScriptRoot) { $candidates.Add($PSScriptRoot) }
    $candidates.Add((Get-Location).Path)
    $desktop = [Environment]::GetFolderPath("Desktop")
    if ($desktop) {
        $candidates.Add($desktop)
        Get-ChildItem -LiteralPath $desktop -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*工作台*" -or $_.Name -like "*ComfyUI*Canvas*" } |
            ForEach-Object { $candidates.Add($_.FullName) }
    }
    foreach ($candidate in $candidates) {
        if (Test-AppRoot $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return ""
}

function Convert-ToVersion([string]$Value) {
    if (-not $Value) { return $null }
    $clean = ($Value.Trim() -replace "^[vV]", "") -replace "\s", ""
    $clean = ($clean -split "[-+]")[0]
    try { return [version]$clean } catch { return $null }
}

function Expand-PatchArchive([string]$Archive, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (Test-Path -LiteralPath $tar) {
        & $tar -xf $Archive -C $Destination
        if ($LASTEXITCODE -eq 0) { return }
        Write-Host "tar 解压失败（exit $LASTEXITCODE），改用 ZIP 方式…" -ForegroundColor DarkYellow
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

function Is-Protected([string]$Relative) {
    $normalized = $Relative.Replace("\", "/").TrimStart("/")
    foreach ($entry in $Protected) {
        if ($normalized -ieq $entry) { return $true }
        if ($normalized.StartsWith("$entry/", [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

Write-Host "============================================" -ForegroundColor DarkGray
Write-Host "  无界工作台 一键更新" -ForegroundColor White
Write-Host "============================================" -ForegroundColor DarkGray

$appRoot = Resolve-AppRoot $Root
if (-not $appRoot) {
    Write-Host "没有自动找到工作台文件夹（需要包含 VERSION、start-local.bat）。" -ForegroundColor Yellow
    $answer = Read-Host "请把工作台文件夹拖到本窗口，或直接粘贴完整路径后回车"
    $answer = $answer.Trim('"', " ")
    if (Test-AppRoot $answer) { $appRoot = (Resolve-Path -LiteralPath $answer).Path }
}
if (-not $appRoot) {
    Write-Host "未找到工作台目录，更新已取消。" -ForegroundColor Red
    exit 2
}
Write-Host "工作台目录：$appRoot"

$currentVersion = ""
try { $currentVersion = (Get-Content -LiteralPath (Join-Path $appRoot "VERSION") -Raw).Trim() } catch { }
Write-Host "当前版本：$currentVersion"

Write-Step "读取更新清单"
$manifest = $null
$manifestUrl = ""
if ($localManifest) {
    $manifest = $localManifest
    Write-Host "使用本地离线补丁：$localPatchPath" -ForegroundColor Green
} else {
    foreach ($url in $ManifestUrls) {
        try {
            $data = Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 30
            if ($data.version) {
                $manifest = $data
                $manifestUrl = $url
                break
            }
        } catch {
            Write-Host "清单不可用：$url（$($_.Exception.Message)）" -ForegroundColor DarkYellow
        }
    }
}
if (-not $manifest) {
    Write-Host "无法获取更新清单，请检查网络后重试。" -ForegroundColor Red
    exit 3
}
Write-Host "最新版本：$($manifest.version)"

$current = Convert-ToVersion $currentVersion
$latest = Convert-ToVersion ([string]$manifest.version)
if ($current -and $latest -and $latest -le $current) {
    Write-Host ""
    Write-Host "当前已经是最新版本，无需更新。" -ForegroundColor Green
    if (-not $NoLaunch) {
        $bat = Join-Path $appRoot "start-local.bat"
        Start-Process -FilePath $bat -WorkingDirectory $appRoot
    }
    exit 0
}

$patch = $manifest.patch
if (-not $patch -or -not $patch.sha256) {
    Write-Host "这个版本没有可用的代码补丁，请到发布页下载完整包。" -ForegroundColor Red
    if ($manifest.repository) { Write-Host "发布页：$($manifest.repository)" }
    exit 4
}
$patchUrl = [string]$patch.url
if (-not $localPatchPath) {
    if (-not $patchUrl) {
        Write-Host "更新清单缺少补丁地址，请到发布页下载完整包。" -ForegroundColor Red
        exit 4
    }
    if ($patchUrl -notmatch "^https?://") {
        $patchUrl = ([Uri]::new([Uri]$manifestUrl, $patchUrl)).AbsoluteUri
    }
}

$tempRoot = Join-Path $env:TEMP ("wujie-update-" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot "patch.zip"
$payload = Join-Path $tempRoot "payload"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    Write-Step "准备更新补丁"
    if ($localPatchPath) {
        Copy-Item -LiteralPath $localPatchPath -Destination $zipPath -Force
        Write-Host "已使用随包补丁（无需联网）" -ForegroundColor Green
    } else {
        Write-Host $patchUrl
        Invoke-WebRequest -Uri $patchUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
    }
    $actualSize = (Get-Item -LiteralPath $zipPath).Length
    if ($patch.size -and $actualSize -ne [int64]$patch.size) {
        throw "补丁大小不一致（$actualSize / $($patch.size)），可能下载不完整，请重试。"
    }
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$patch.sha256).ToLowerInvariant()) {
        throw "补丁校验失败，请重试；如果反复失败，请下载完整包。"
    }
    Write-Host "校验通过（$([math]::Round($actualSize / 1MB, 1)) MB）" -ForegroundColor Green

    Write-Step "解压补丁"
    Expand-PatchArchive $zipPath $payload
    $sourceRoot = $payload
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "VERSION"))) {
        $dirs = Get-ChildItem -LiteralPath $payload -Directory
        if ($dirs.Count -eq 1) { $sourceRoot = $dirs[0].FullName }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "VERSION"))) {
        throw "补丁内容不完整（缺少 VERSION）。"
    }
    # $env:TEMP 可能是 8.3 短路径，而 Get-ChildItem 返回长路径；统一成完整路径再算相对路径。
    $sourceRoot = (Get-Item -LiteralPath $sourceRoot).FullName.TrimEnd("\")

    Write-Step "替换程序文件（保留 data、models、node_modules 和配置）"
    $backupRoot = Join-Path $appRoot (".update-backup\bridge-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    $written = New-Object System.Collections.Generic.List[string]
    $backups = @{}
    $skipped = 0
    try {
        $files = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force
        foreach ($file in $files) {
            $fileFull = (Get-Item -LiteralPath $file.FullName).FullName
            $relative = $fileFull.Substring($sourceRoot.Length).TrimStart([char[]]@("\", "/"))
            if (Is-Protected $relative) { $skipped += 1; continue }
            $destination = Join-Path $appRoot $relative
            if (Test-Path -LiteralPath $destination) {
                $backupPath = Join-Path $backupRoot $relative
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
                Copy-Item -LiteralPath $destination -Destination $backupPath -Force
                $backups[$destination] = $backupPath
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
            $written.Add($destination)
        }
    } catch {
        Write-Host "替换过程中出错，正在回滚…" -ForegroundColor Red
        foreach ($destination in $written) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        }
        foreach ($destination in $backups.Keys) {
            Copy-Item -LiteralPath $backups[$destination] -Destination $destination -Force -ErrorAction SilentlyContinue
        }
        throw
    }
    Write-Host "已更新 $($written.Count) 个文件（跳过 $skipped 个受保护文件）" -ForegroundColor Green

    if ($patch.url) {
        try {
            $manifestJson = $manifest | ConvertTo-Json -Depth 10
            [IO.File]::WriteAllText((Join-Path $appRoot "update.json"), $manifestJson, (New-Object Text.UTF8Encoding($false)))
        } catch {
            Write-Host "本地 update.json 同步失败（不影响使用）：$($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }

    $installedVersion = (Get-Content -LiteralPath (Join-Path $appRoot "VERSION") -Raw).Trim()
    Write-Step "更新完成：$currentVersion → $installedVersion"

    $config = $null
    try { $config = Get-Content -LiteralPath (Join-Path $appRoot "launcher\config.json") -Raw | ConvertFrom-Json } catch { }
    $gatewayPort = 8190
    $canvasPort = 3000
    $controlPort = 8290
    if ($config) {
        if ($config.gatewayPort) { $gatewayPort = [int]$config.gatewayPort }
        if ($config.canvasPort) { $canvasPort = [int]$config.canvasPort }
        if ($config.controlPort) { $controlPort = [int]$config.controlPort }
    }

    $running = $false
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$gatewayPort/health" -TimeoutSec 3
        $running = $true
    } catch { $running = $false }

    if ($NoLaunch) {
        Write-Host "已跳过自动启动。"
        exit 0
    }

    if ($running) {
        $restarted = $false
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/restart-gateway" -Method Post -TimeoutSec 10
            $restarted = $true
        } catch { $restarted = $false }
        if ($restarted) {
            Start-Sleep -Seconds 4
            try { Start-Process "http://127.0.0.1:$canvasPort/" } catch { }
            Write-Host ""
            Write-Host "更新完成，网关已重启，画布已打开。" -ForegroundColor Green
            exit 0
        }
        Write-Host ""
        Write-Host "更新文件已替换。请关闭当前工作台窗口，再双击 start-local.bat 启动新版本。" -ForegroundColor Yellow
        exit 0
    }

    Start-Process -FilePath (Join-Path $appRoot "start-local.bat") -WorkingDirectory $appRoot
    Write-Host ""
    Write-Host "更新完成，正在启动工作台…" -ForegroundColor Green
    exit 0
} catch {
    Write-Host ""
    Write-Host "更新失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "原有文件未被替换（或已回滚），可以直接重新运行本程序。" -ForegroundColor Yellow
    exit 1
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
