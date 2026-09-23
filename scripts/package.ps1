$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
& node (Join-Path $PSScriptRoot 'build.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Build failed; the existing release ZIP was not changed.' }
$distPath = Join-Path $repoRoot 'dist'
$manifest = [IO.File]::ReadAllText((Join-Path $distPath 'manifest.json')) | ConvertFrom-Json
$releasePath = Join-Path $repoRoot 'releases'
[IO.Directory]::CreateDirectory($releasePath) | Out-Null
$zipPath = Join-Path $releasePath ('chzzk-downloader-v' + $manifest.version + '.zip')
$temporary = Join-Path $releasePath ('.package-' + [Guid]::NewGuid().ToString('N') + '.zip')
$files = @(Get-ChildItem -LiteralPath $distPath -Recurse -File | Sort-Object FullName)
$entries = @{}
foreach ($file in $files) {
  $absolute = [IO.Path]::GetFullPath($file.FullName)
  if (!$absolute.StartsWith($distPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path is outside dist.' }
  $relative = $absolute.Substring($distPath.Length + 1).Replace('\', '/')
  $entries[$relative] = $absolute
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = $null
try {
  $archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
  foreach ($relative in ($entries.Keys | Sort-Object)) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entries[$relative], $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
  $archive.Dispose()
  $archive = [IO.Compression.ZipFile]::OpenRead($temporary)
  if ($archive.Entries.Count -ne $entries.Count -or $null -eq $archive.GetEntry('manifest.json')) { throw 'Invalid extension ZIP layout.' }
  foreach ($entry in $archive.Entries) {
    if (!$entries.ContainsKey($entry.FullName)) { throw ('Unexpected ZIP entry: ' + $entry.FullName) }
    $stream = $entry.Open()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $zipHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $hasher.Dispose() }
    $sourceStream = [IO.File]::OpenRead($entries[$entry.FullName])
    $sourceHasher = [Security.Cryptography.SHA256]::Create()
    try { $sourceHash = [BitConverter]::ToString($sourceHasher.ComputeHash($sourceStream)).Replace('-', '') } finally { $sourceStream.Dispose(); $sourceHasher.Dispose() }
    if ($zipHash -ne $sourceHash) { throw ('ZIP hash mismatch: ' + $entry.FullName) }
  }
  $archive.Dispose()
  $archive = $null
  Move-Item -LiteralPath $temporary -Destination $zipPath -Force
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Write-Host "Packaged v$($manifest.version): $zipPath ($($entries.Count) verified runtime files)"
