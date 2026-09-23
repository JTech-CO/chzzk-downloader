$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$zipPath = Join-Path $root 'chzzk-downloader.zip'

$include = @(
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'offscreen.html',
  'offscreen.js',
  'icons\icon16.png',
  'icons\icon48.png',
  'icons\icon128.png'
)

$staging = Join-Path $root '.package'
if (Test-Path -LiteralPath $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging | Out-Null

foreach ($relative in $include) {
  $src = Join-Path $root $relative
  if (!(Test-Path -LiteralPath $src)) {
    throw "Missing package file: $relative"
  }

  $dst = Join-Path $staging $relative
  $dstDir = Split-Path -Parent $dst
  if (!(Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir | Out-Null
  }
  Copy-Item -LiteralPath $src -Destination $dst -Force
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $staging -Recurse -Force

Write-Host "Packaged $zipPath"
