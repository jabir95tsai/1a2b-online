$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactDirectory = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$archivePath = Join-Path $artifactDirectory '1a2b-online-source.zip'
$folders = @('src', 'public', 'scripts', 'tests', 'docs', 'reports')
$rootFiles = @('README.md', 'package.json', 'package-lock.json', 'index.html', '.gitignore', '.dev.vars.example', 'tsconfig.json', 'tsconfig.client.json', 'vite.config.ts', 'vitest.config.ts', 'vitest.runtime.config.ts', 'wrangler.jsonc', 'worker-configuration.d.ts')
$files = @()
foreach ($folder in $folders) { $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -Recurse -File }
foreach ($file in $rootFiles) { $files += Get-Item -LiteralPath (Join-Path $projectRoot $file) }
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
        if ($relative.StartsWith('reports/browser/')) { continue }
        if ($relative -match '(^|/)(node_modules|\.wrangler|\.npm-cache|\.git)(/|$)' -or $relative -match '(^|/)\.dev\.vars$') { throw 'Private path rejected from source archive.' }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose(); $stream.Dispose() }
$verify = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = @($verify.Entries | ForEach-Object { $_.FullName })
    foreach ($required in @('README.md', 'wrangler.jsonc', 'src/server/index.ts', 'src/client/main.ts', 'reports/deployment.md')) {
        if ($names -notcontains $required) { throw "Missing archive entry: $required" }
    }
    Write-Output "Source archive verified: $($names.Count) entries; no runtime data or secrets included."
} finally { $verify.Dispose() }
Get-FileHash -LiteralPath $archivePath -Algorithm SHA256 | Select-Object Algorithm, Hash
