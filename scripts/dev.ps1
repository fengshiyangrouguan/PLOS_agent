<#
.SYNOPSIS
  以源码方式启动 DSH，并把 stdout / stderr 同时落到 logs/。

.DESCRIPTION
  DSH 的开发入口是源码直跑（node --import tsx/esm apps/cli/src/bin.ts），不需要
  pnpm run build——那是发布用的 artifact plane。本脚本只做三件事：设好 $DSH_HOME、
  切到 DSH 安装目录、把输出 tee 到带时间戳的日志文件。

.PARAMETER Profile
  profile 名，即 profiles/ 下的目录名。

.PARAMETER AppArgs
  透传给被启动 app 的参数，放在参数列表最后。例如 headless 的任务串。

.EXAMPLE
  .\scripts\dev.ps1
  .\scripts\dev.ps1 -Profile main

.NOTES
  本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的 .ps1
  按 ANSI 读，中文注释会直接把语法搞崩（本项目实测踩过）。

  另外这里刻意 **不设** `$ErrorActionPreference = 'Stop'`：pnpm 的 shim 会往 stderr
  写一行命令行回显，在 `Stop` + `2>&1` 的组合下会被 PS 5.1 当成终止性错误，
  脚本会在启动前就死掉、日志文件根本不生成。
#>
[CmdletBinding()]
param(
  [string]$Profile = 'main',
  [Parameter(ValueFromRemainingArguments)]
  [string[]]$AppArgs = @()
)

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path $PSScriptRoot -Parent
$dshRepo = (Resolve-Path (Join-Path $repoRoot '..\deepseek-harness')).Path
$logDir = Join-Path $repoRoot 'logs'
$logFile = Join-Path $logDir ('{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Profile)

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:DSH_HOME = $repoRoot

Write-Host 'DSH_HOME  ' -NoNewline -ForegroundColor DarkGray; Write-Host $repoRoot
Write-Host 'DSH 安装  ' -NoNewline -ForegroundColor DarkGray; Write-Host $dshRepo
Write-Host 'profile   ' -NoNewline -ForegroundColor DarkGray; Write-Host $Profile
Write-Host '日志      ' -NoNewline -ForegroundColor DarkGray; Write-Host $logFile -ForegroundColor Yellow
Write-Host ''

Push-Location $dshRepo
try {
  & pnpm dsh --profile $Profile @AppArgs 2>&1 | Tee-Object -FilePath $logFile
}
finally {
  Pop-Location
}
