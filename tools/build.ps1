# Build the chime player (C# 5, /target:winexe, .NET Framework only).
#
# ASCII-only on purpose: PowerShell 5.1 reads BOM-less files as ANSI, and a
# stray Chinese comment here would turn into mojibake and break parsing.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$ref = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.1'

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
if (-not (Test-Path (Join-Path $ref 'mscorlib.dll'))) {
    throw "the .NET Framework 4.7.1 reference assemblies are missing: $ref"
}

$bin = Join-Path $root 'bin'
if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

$out = Join-Path $bin 'chime.exe'

# /noconfig is required: the framework csc.rsp would otherwise pull the 4.0
# runtime assemblies in next to the 4.7.1 reference assemblies and collide.
$cscArgs = @(
    '/nologo', '/noconfig', '/nostdlib+', '/target:winexe', '/platform:anycpu',
    "/out:$out",
    '/warn:4',
    "/r:$ref\mscorlib.dll",
    "/r:$ref\System.dll",
    (Join-Path $root 'src\chime.cs')
)

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }

$file = Get-Item $out
"built {0} ({1:N0} bytes)" -f $file.FullName, $file.Length
