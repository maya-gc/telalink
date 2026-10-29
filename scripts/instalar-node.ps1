# =============================================================================
#  TelaLink - prepara o Node.js no Windows, sozinho e sem administrador.
# -----------------------------------------------------------------------------
#  1. Se o computador ja tem Node.js 20 ou mais novo, usa ele.
#  2. Senao, baixa o Node.js LTS OFICIAL (nodejs.org) para a pasta .runtime
#     do proprio TelaLink - nada e instalado no sistema.
#  Seguranca: o arquivo baixado so e aceito se
#     - o SHA-256 bater com a lista oficial (SHASUMS256.txt) e
#     - o node.exe tiver assinatura digital VALIDA da OpenJS Foundation.
#  Resultado: grava o caminho do node a usar em .runtime\node-path.txt
# =============================================================================
param(
  [string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'),
  [string]$DistUrl = 'https://nodejs.org/dist',
  [int]$MinMajor = 20,
  [switch]$Force,
  [switch]$SkipSignature   # so para testes com servidor falso (nunca no uso normal)
)
$ErrorActionPreference = 'Stop'
# Aberto a partir do PowerShell 7, o Windows PowerShell herda um caminho de
# modulos que quebra a verificacao de assinatura: volta ao caminho padrao.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
}
$ProgressPreference = 'SilentlyContinue'   # deixa o download muito mais rapido
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Say($msg) { Write-Host "        $msg" }
function NodeMajor($exe) {
  try { $v = (& $exe --version) 2>$null; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch {}
  return 0
}
function Done($exe) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Set-Content -Path (Join-Path $Dest 'node-path.txt') -Value $exe -Encoding ASCII -NoNewline
  exit 0
}

$nodeDir = Join-Path $Dest 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'

if (-not $Force) {
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys -and (NodeMajor $sys.Source) -ge $MinMajor) { Say "Node.js do sistema: $(& $sys.Source --version)"; Done $sys.Source }
  if ((Test-Path $nodeExe) -and (NodeMajor $nodeExe) -ge $MinMajor) { Say "Node.js do TelaLink: $(& $nodeExe --version)"; Done $nodeExe }
}

Say 'Node.js nao encontrado: baixando a versao oficial (so na primeira vez)...'
$arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }

$index = Invoke-RestMethod -Uri "$DistUrl/index.json" -UseBasicParsing
$rel = $index | Where-Object {
  $_.lts -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge 22) -and ($_.files -contains "win-$arch-zip")
} | Select-Object -First 1
if (-not $rel) { throw "nenhuma versao LTS encontrada para win-$arch" }
$ver = $rel.version
$name = "node-$ver-win-$arch"
$zipName = "$name.zip"
Say "Versao LTS: $ver ($arch)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('telalink-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp $zipName
  Invoke-WebRequest -Uri "$DistUrl/$ver/$zipName" -OutFile $zip -UseBasicParsing
  $sums = [string](Invoke-WebRequest -Uri "$DistUrl/$ver/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match ('^([0-9a-f]{64})\s+' + [regex]::Escape($zipName) + '\s*$') } | Select-Object -First 1
  if (-not $line) { throw "o arquivo $zipName nao esta na lista oficial de hashes" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($actual -ne $expected) { throw "SHA-256 NAO confere (esperado $expected, recebido $actual): download recusado" }
  Say 'SHA-256 conferido com a lista oficial.'

  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $exe = Join-Path (Join-Path $tmp $name) 'node.exe'
  if (-not $SkipSignature) {
    $sig = Get-AuthenticodeSignature -LiteralPath $exe
    if ($sig.Status -ne 'Valid') { throw "assinatura digital do node.exe: $($sig.Status)" }
    if ($sig.SignerCertificate.Subject -notmatch 'O="?(OpenJS Foundation|Node\.js Foundation)') { throw "node.exe assinado por outra empresa: $($sig.SignerCertificate.Subject)" }
    Say 'Assinatura digital da OpenJS Foundation conferida.'
  }
  if ((NodeMajor $exe) -lt $MinMajor) { throw 'o Node.js baixado nao executou' }

  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  if (Test-Path $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $nodeDir
  Say "Pronto: Node.js $ver na pasta do TelaLink."
  Done $nodeExe
} catch {
  Write-Host ''
  Write-Host "  [ERRO] Nao foi possivel preparar o Node.js: $($_.Exception.Message)"
  Write-Host '  Sem internet? Instale manualmente em https://nodejs.org (versao LTS).'
  exit 1
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
