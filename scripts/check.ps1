<#
.SYNOPSIS
  插件改完后的两层快速验证：TypeScript 类型 + 装配树。

.DESCRIPTION
  1. 用 profiles/<Profile>/tsconfig.json 做类型检查（解析 @deepseek-ai/* 到已构建的包）。
  2. --dump-config 打印叠完之后的装配树，并摘出「由我们的补丁层贡献/修改」的行。
     不挂载、不需要 API key，所以可以随时跑。

  退出码非 0 表示类型检查失败。

.PARAMETER Profile
  profile 名，即 profiles/ 下的目录名。

.EXAMPLE
  pwsh -File scripts/check.ps1
#>
[CmdletBinding()]
param([string]$Profile = 'main')

$repoRoot = Split-Path $PSScriptRoot -Parent
$dshRepo = (Resolve-Path (Join-Path $repoRoot '..\deepseek-harness')).Path
$profileDir = Join-Path $repoRoot "profiles\$Profile"
$tsconfig = Join-Path $profileDir 'tsconfig.json'

Write-Host '[1/2] TypeScript' -ForegroundColor Cyan
& node (Join-Path $dshRepo 'node_modules\typescript\bin\tsc') -p $tsconfig
$tscExit = $LASTEXITCODE
if ($tscExit -eq 0) { Write-Host '      通过' -ForegroundColor Green }
else { Write-Host '      失败（见上）' -ForegroundColor Red }

Write-Host ''
Write-Host '[2/2] 装配树' -ForegroundColor Cyan

$env:DSH_HOME = $repoRoot
Push-Location $dshRepo
try {
  $tree = & pnpm dsh --profile $Profile --dump-config 2>$null
}
finally {
  Pop-Location
}

if ($LASTEXITCODE -ne 0 -or -not $tree) {
  Write-Host '      --dump-config 失败' -ForegroundColor Red
  exit 1
}

# dump 的每一段都以 `# == <来源>` 标注该段来自哪一层。据此摘出我们自己的行：
# 既包括我们 insert 的，也包括我们按 id 覆盖过的（标注形如
# `# == @deepseek-ai/dsh-base, patched by <我们的补丁层>`）。
$marker = ''
$mine = [System.Collections.Generic.List[string]]::new()
foreach ($line in $tree) {
  if ($line -match '^# == (.+)$') { $marker = $Matches[1]; continue }
  if ($line -match '^- id: (.+)$' -and $marker -like "*profiles\$Profile\cordis.patch.yml*") {
    $mine.Add($Matches[1])
  }
}

$total = @($tree | Select-String '^- id:').Count
Write-Host ("      条目总数 : {0}" -f $total)
if ($mine.Count -eq 0) {
  Write-Host '      我们的补丁层 : 没有任何行生效 —— 检查 cordis.patch.yml 的 id / 路径' -ForegroundColor Red
}
else {
  Write-Host ("      我们的补丁层 : {0} 行" -f $mine.Count) -ForegroundColor Green
  foreach ($id in $mine) { Write-Host "        - $id" }
}

exit $tscExit
