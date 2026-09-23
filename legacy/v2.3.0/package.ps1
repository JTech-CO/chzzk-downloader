$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$zipPath = Join-Path $root 'chzzk-downloader.zip'
$temporary = Join-Path $root ('.package-' + [Guid]::NewGuid().ToString('N') + '.zip')
$include = @(
  'manifest.json', 'background.js', 'download-core.js', 'media-plan.js',
  'download-engine.js', 'mp4.js', 'dash-parser.js', 'media-resolver.js',
  'content.js', 'content.css', 'offscreen.html', 'offscreen.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
)
foreach ($relative in $include) {
  if (!(Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { throw "Missing package file: $relative" }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = $null
try {
  $archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
  foreach ($relative in $include) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $root $relative), $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
  $archive.Dispose()
  $archive = $null
  Move-Item -LiteralPath $temporary -Destination $zipPath -Force
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  # Only the single, explicitly created temporary archive is ever removed.
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "Packaged v$($manifest.version): $zipPath"
