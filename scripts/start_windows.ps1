[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 43127,
    [ValidateRange(1024, 65535)][int]$ApiPort = 43128,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tomota = Join-Path $repoRoot ".venv\Scripts\tomota.exe"
$studioIndex = Join-Path $repoRoot "studio\dist\index.html"

if (-not (Test-Path -LiteralPath $tomota) -or -not (Test-Path -LiteralPath $studioIndex)) {
    throw "Tomota is not installed or built. Run scripts\setup_windows.ps1 first."
}

$arguments = @("--root", $repoRoot, "studio", "--port", [string]$Port, "--api-port", [string]$ApiPort)
if ($NoOpen) { $arguments += "--no-open" }
& $tomota @arguments
