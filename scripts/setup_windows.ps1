[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$InstallCodexSkill
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$studioRoot = Join-Path $repoRoot "studio"
$venvRoot = Join-Path $repoRoot ".venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing $Name. $InstallHint"
    }
}

Require-Command "python" "Install Python 3.11+ and enable Add Python to PATH."
Require-Command "node" "Install Node.js 20 LTS or newer."
Require-Command "npm" "npm is normally included with Node.js."

$pythonVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$pythonVersion -lt [version]"3.11") {
    throw "Python $pythonVersion is too old; Python 3.11+ is required."
}
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
    throw "Node.js $(& node --version) is too old; Node.js 20+ is required."
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    & python -m venv $venvRoot
}
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -e $repoRoot

Push-Location $studioRoot
try {
    & npm ci
    & npm run build
    if (-not $SkipTests) {
        & npm test
    }
} finally {
    Pop-Location
}

if (-not $SkipTests) {
    $priorPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = Join-Path $repoRoot "src"
        & $venvPython -m unittest discover -s (Join-Path $repoRoot "tests") -p "test_*.py"
        & node --test (Join-Path $repoRoot "tests\test_browser_bridge.mjs")
    } finally {
        $env:PYTHONPATH = $priorPythonPath
    }
}

if ($InstallCodexSkill) {
    & (Join-Path $repoRoot "scripts\install_codex_skill.ps1")
}

Write-Host ""
Write-Host "Tomota Studio installation completed." -ForegroundColor Green
Write-Host "Start with: powershell -ExecutionPolicy Bypass -File `"$repoRoot\scripts\start_windows.ps1`""
