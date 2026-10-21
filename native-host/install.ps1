param(
  [Parameter()]
  [ValidatePattern("^[a-p]{32}$")]
  [string] $ExtensionId = "mcmlpkfikipagohcahncghpaonhionpp"
)

$ErrorActionPreference = "Stop"
$nativeHostDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $nativeHostDirectory
$projectPath = Join-Path $nativeHostDirectory "JobHistoryHost.csproj"
$publishDirectory = Join-Path $nativeHostDirectory "publish"
$hostPath = Join-Path $publishDirectory "JobHistoryHost.exe"
$manifestPath = Join-Path $nativeHostDirectory "com.jobextensions.history.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.jobextensions.history"

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot "manifest.json"))) {
  throw "The extension manifest was not found in $repositoryRoot."
}

& dotnet publish $projectPath --configuration Release --runtime win-x64 --self-contained true --output $publishDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Could not build the local job-history backup host."
}

$hostManifest = @{
  name = "com.jobextensions.history"
  description = "Local append-only Job Extensions history backup"
  path = $hostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
  $manifestPath,
  $hostManifest,
  [System.Text.UTF8Encoding]::new($false)
)

New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Output "Native backup host registered for Chrome extension $ExtensionId."
Write-Output "Job history archive: $(Join-Path $repositoryRoot 'job-history-backup.jsonl')"
Write-Output "The archive is append-only and excluded from Git."
