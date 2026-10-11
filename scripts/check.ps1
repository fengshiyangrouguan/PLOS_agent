<#
.SYNOPSIS
  插件改完后的三层快速验证：TypeScript 类型 + 装配树 + 渲染自检。

.DESCRIPTION
  1. 用 profiles/<Profile>/tsconfig.json 做类型检查（解析 @deepseek-ai/* 到已构建的包）。
  2. --dump-config 打印叠完之后的装配树，并摘出「由我们的补丁层贡献/修改」的行。
     不挂载、不需要 API key，所以可以随时跑。
  3. 跑 plugins/ 下所有 *.spec.ts。渲染器是纯函数、零依赖，所以能离网钉死格式——
     真实 QQ 流量复现不了每种段型（转发、嵌套、各种降级），格式必须靠这个守。

  退出码非 0 表示任一步失败。

.PARAMETER Profile
  profile 名，即 profiles/ 下的目录名。

.EXAMPLE
  powershell -File scripts/check.ps1
#>
[CmdletBinding()]
param([string]$Profile = 'main')

$repoRoot = Split-Path $PSScriptRoot -Parent
$dshRepo = (Resolve-Path (Join-Path $repoRoot '..\deepseek-harness')).Path
$profileDir = Join-Path $repoRoot "profiles\$Profile"
$tsconfig = Join-Path $profileDir 'tsconfig.json'
$failed = $false

Write-Host '[1/3] TypeScript' -ForegroundColor Cyan
& node (Join-Path $dshRepo 'node_modules\typescript\bin\tsc') -p $tsconfig
if ($LASTEXITCODE -eq 0) { Write-Host '      通过' -ForegroundColor Green }
else { Write-Host '      失败（见上）' -ForegroundColor Red; $failed = $true }

Write-Host ''
Write-Host '[2/3] 装配树' -ForegroundColor Cyan

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
  $failed = $true
}
else {
  Write-Host ("      我们的补丁层 : {0} 行" -f $mine.Count) -ForegroundColor Green
  foreach ($id in $mine) { Write-Host "        - $id" }
}

Write-Host ''
Write-Host '[3/3] 自检脚本' -ForegroundColor Cyan
$specs = @(Get-ChildItem (Join-Path $profileDir 'plugins') -Recurse -File -Filter '*.spec.ts' -ErrorAction SilentlyContinue)
if ($specs.Count -eq 0) {
  Write-Host '      没有 *.spec.ts，跳过'
}
else {
  # 从 deepseek-harness 跑：tsx 装在那里，而 profile 的 node_modules 里没有。
  Push-Location $dshRepo
  try {
    foreach ($spec in $specs) {
      $out = & node --import tsx/esm $spec.FullName 2>&1
      $summary = @($out | Select-String '通过 (\d+)，失败 (\d+)' | Select-Object -Last 1)
      if ($LASTEXITCODE -eq 0) {
        Write-Host ("      {0}  {1}" -f $spec.Name, $(if ($summary) { $summary[0].Line } else { '通过' })) -ForegroundColor Green
      }
      else {
        Write-Host ("      {0} 失败：" -f $spec.Name) -ForegroundColor Red
        $out | ForEach-Object { Write-Host "        $_" }
        $failed = $true
      }
    }
  }
  finally {
    Pop-Location
  }
}

if ($failed) { exit 1 }
exit 0
