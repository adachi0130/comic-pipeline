# 拉取锁定版本的 Manga Editor Desu! 到 backend/static/editor/
# 用法：powershell -ExecutionPolicy Bypass -File backend/scripts/fetch_editor.ps1
$ErrorActionPreference = "Stop"

$Commit = "04e0cf3de1f3677682f6d1831f2713db70e441ba"
$Repo = "new-sankaku/manga-editor-desu"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Dest = Join-Path $Root "backend\static\editor"
$Tmp = Join-Path $env:TEMP "med_fetch"

Write-Host "拉取 $Repo @ $Commit ..."
if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp }
New-Item -ItemType Directory -Path $Tmp | Out-Null

$Zip = Join-Path $Tmp "med.zip"
Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$Commit" -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force

$SrcDir = Get-ChildItem -Path $Tmp -Directory | Where-Object { $_.Name -like "manga-editor-desu-*" } | Select-Object -First 1
if (-not $SrcDir) { throw "解压后未找到源码目录" }

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Path $Dest | Out-Null

$Keep = @("index.html","css","js","third","font","02_images_svg","03_images","json_js",
          "manifest.json","service-worker.js","favicon.ico","favicon.svg","package.json","LICENSE","robots.txt")
foreach ($item in $Keep) {
    $p = Join-Path $SrcDir.FullName $item
    if (Test-Path $p) { Copy-Item -Recurse -Force $p (Join-Path $Dest $item) }
}

Write-Host "已就位：$Dest"
