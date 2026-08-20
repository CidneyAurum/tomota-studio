[CmdletBinding()]
param(
    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "skills\webnovel-writing"))
$userRoot = [Environment]::GetFolderPath("UserProfile")
$skillsRoot = [System.IO.Path]::GetFullPath((Join-Path $userRoot ".codex\skills"))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $skillsRoot "webnovel-writing"))

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "SKILL.md"))) {
    throw "Bundled skill is missing: $sourceRoot"
}
if (-not $sourceRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Bundled skill resolved outside the repository."
}
if (-not $targetRoot.StartsWith($skillsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Skill target resolved outside the Codex skills directory."
}

if (Test-Path -LiteralPath $targetRoot) {
    if (-not $Replace) {
        throw "A webnovel-writing skill already exists at $targetRoot. Re-run with -Replace to back it up and install the bundled version."
    }
    $backupRoot = "$targetRoot.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $targetRoot -Destination $backupRoot
    Write-Host "Existing skill moved to: $backupRoot" -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination $targetRoot -Recurse
Write-Host "Codex skill installed at: $targetRoot" -ForegroundColor Green
