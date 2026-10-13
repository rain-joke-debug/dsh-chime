# Set the chime volume, then play a preview so you can hear the result.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\volume.ps1 60
#
# This writes volume.txt next to impl.js, which is re-read on every chime, so
# the new level applies to the very next sound with no DSH restart.
#
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less files as ANSI, and a
# stray non-ASCII character here would turn into mojibake and break parsing.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateRange(0, 200)]
    [int]$Volume
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'bin\chime.exe'

if (-not (Test-Path $exe)) { throw "player not built: $exe (run tools\build.ps1)" }

Set-Content -Path (Join-Path $root 'volume.txt') -Value $Volume -Encoding ASCII
"volume.txt = $Volume percent"

# Start-Process -Wait: chime.exe is a winexe, so a plain call would not wait for
# the sound to finish.
Start-Process -FilePath $exe -ArgumentList 'ding', $Volume -Wait
