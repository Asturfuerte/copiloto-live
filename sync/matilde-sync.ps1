# Matilde Sync: vigila la carpeta Matilde del PC y sube a Copiloto Live todo documento nuevo o modificado.
#
# Estructura de la carpeta:
#   Matilde\              -> SOLO los ficheros del usuario. Lo que se deje aquí (pdf, docx, md, txt) se sube solo.
#   Matilde\no tocar\     -> este programa, su configuración (matilde-sync.json), el registro y el estado.
#
# Uso: doble clic en "no tocar\ARRANCAR MATILDE SYNC.bat" (se copia solo al Inicio de Windows; después arranca con el PC).
# Configuración (no tocar\matilde-sync.json):
#   { "url": "https://live.asturfuerte.es", "pin": "1234", "intervalo": 10, "borrarRemoto": false }
#   - carpeta (opcional): otra carpeta a vigilar; por defecto, la carpeta Matilde (la que contiene "no tocar").

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ext = @('.pdf', '.docx', '.md', '.txt')
$mios = @('matilde-sync.ps1', 'matilde-sync.json', 'matilde-sync.ejemplo.json', 'matilde-sync.estado.json', 'matilde-sync.log', 'matilde-sync.bat', 'ARRANCAR MATILDE SYNC.bat', 'LEEME.md', 'LEEME.txt')

# ---- Dónde estoy y ordenar la carpeta (migración de la estructura antigua) ----
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $aqui) -ieq 'no tocar') { $base = Split-Path -Parent $aqui } else { $base = $aqui }
$nt = Join-Path $base 'no tocar'
if (-not (Test-Path $nt)) { New-Item -ItemType Directory -Path $nt | Out-Null }

function Ordenar {
  # 1) mis ficheros que estén en la raíz -> "no tocar" (los que ya existen allí se sobrescriben con los más nuevos)
  foreach ($n in $mios) {
    $src = Join-Path $base $n
    if (Test-Path $src) {
      if ($n -in @('matilde-sync.bat', 'LEEME.txt')) { Remove-Item $src -Force -ErrorAction SilentlyContinue; continue }  # obsoletos
      $dst = Join-Path $nt $n
      try { Move-Item $src $dst -Force } catch { try { Copy-Item $src $dst -Force; Remove-Item $src -Force } catch {} }
    }
  }
  # 2) ficheros generados por Claude (OCR) en la raíz: ya están en el servidor, fuera
  Get-ChildItem -Path $base -File -Filter '* (OCR).txt' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  # 3) la antigua subcarpeta "subir": su contenido pasa a la raíz y se elimina
  $subir = Join-Path $base 'subir'
  if (Test-Path $subir) {
    Get-ChildItem -Path $subir -File | ForEach-Object {
      if ($_.Name -like 'LEEME*') { Remove-Item $_.FullName -Force; return }
      $dst = Join-Path $base $_.Name
      if (-not (Test-Path $dst)) { Move-Item $_.FullName $dst } else { Remove-Item $_.FullName -Force }
    }
    if (-not (Get-ChildItem -Path $subir -Force)) { Remove-Item $subir -Force }
  }
  # 4) el lanzador también en el Inicio de Windows (así arranca con el PC)
  $inicio = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $lanzador = Join-Path $nt 'ARRANCAR MATILDE SYNC.bat'
  if ((Test-Path $inicio) -and (Test-Path $lanzador)) {
    Copy-Item $lanzador (Join-Path $inicio 'ARRANCAR MATILDE SYNC.bat') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $inicio 'matilde-sync.bat') -Force -ErrorAction SilentlyContinue
  }
}
try { Ordenar } catch { Write-Host "Aviso al ordenar: $($_.Exception.Message)" }

# ---- Configuración ----
$cfgPath = Join-Path $nt 'matilde-sync.json'
if (-not (Test-Path $cfgPath)) { Write-Host "Falta $cfgPath"; Read-Host 'Pulsa Enter para salir'; exit 1 }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$url = $cfg.url.TrimEnd('/')
$pin = [string]$cfg.pin
$carpeta = if ($cfg.carpeta -and (Test-Path $cfg.carpeta) -and -not ($cfg.carpeta -like '*\subir')) { $cfg.carpeta } else { $base }
$intervalo = if ($cfg.intervalo) { [int]$cfg.intervalo } else { 10 }
$borrarRemoto = [bool]$cfg.borrarRemoto
$estadoPath = Join-Path $nt 'matilde-sync.estado.json'
$logPath = Join-Path $nt 'matilde-sync.log'

function Log($msg) {
  $linea = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $linea
  Add-Content -Path $logPath -Value $linea -Encoding UTF8
}
function Enc($name) { [System.Uri]::EscapeDataString($name) }

# Estado: fichero -> "tamaño|fecha" de la última subida correcta
$estado = @{}
if (Test-Path $estadoPath) {
  try { (Get-Content $estadoPath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $estado[$_.Name] = $_.Value } } catch {}
}
function GuardarEstado { $estado | ConvertTo-Json | Set-Content -Path $estadoPath -Encoding UTF8 }
$visto = @{}

Log "Matilde Sync vigilando $carpeta -> $url (cada $intervalo s). Deja esta ventana abierta (minimizada vale)."
try { $s = Invoke-RestMethod -Uri "$url/salud" -TimeoutSec 15; Log ("Servidor OK: agente '{0}', {1} documento(s) cargado(s)." -f $s.nombre, @($s.documentos).Count) } catch { Log "Aviso: no se pudo consultar $url/salud ($($_.Exception.Message))" }

$vuelta = 0
while ($true) {
  try {
    $vuelta++
    if ($vuelta % 30 -eq 0) { try { Ordenar } catch {} }   # cada ~5 min mantiene la carpeta ordenada
    $ficheros = Get-ChildItem -Path $carpeta -File | Where-Object { $ext -contains $_.Extension.ToLower() -and -not $_.Name.StartsWith('.') -and -not $_.Name.StartsWith('~$') -and $_.Name -notlike 'LEEME*' -and $_.Name -notlike 'matilde-sync*' -and $_.Name -notlike 'ARRANCAR*' -and $_.Name -notlike '* (OCR).txt' }
    $nombres = @{}
    foreach ($f in $ficheros) {
      $nombres[$f.Name] = $true
      $firma = "{0}|{1}" -f $f.Length, $f.LastWriteTimeUtc.Ticks
      if ($estado[$f.Name] -eq $firma) { continue }
      if ($visto[$f.Name] -ne $firma) { $visto[$f.Name] = $firma; continue }   # esperar a que deje de crecer
      Log "Subiendo $($f.Name) ($([math]::Round($f.Length/1KB)) KB)..."
      try {
        $r = Invoke-RestMethod -Uri "$url/documentos/$(Enc $f.Name)?pin=$(Enc $pin)" -Method Put -InFile $f.FullName -ContentType 'application/octet-stream' -TimeoutSec 900
        if ($r.procesando) { Log "  Recibido: es un escaneo; el servidor le está pasando OCR (unos 8 s por página). Después ya se puede consultar." }
        else { Log ("  OK: {0} ({1} fragmentos). Matilde ya puede consultarlo." -f $r.documento.fichero, $r.documento.fragmentos) }
        $estado[$f.Name] = $firma; GuardarEstado
      } catch {
        $detalle = $_.Exception.Message
        try { $detalle = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
        Log "  ERROR al subir $($f.Name): $detalle"
        $estado[$f.Name] = "error|$firma"; GuardarEstado
      }
    }
    if ($borrarRemoto) {
      foreach ($n in @($estado.Keys)) {
        if (-not $nombres[$n]) {
          try { Invoke-RestMethod -Uri "$url/documentos/$(Enc $n)?pin=$(Enc $pin)" -Method Delete -TimeoutSec 30 | Out-Null; Log "Borrado en Copiloto Live: $n" } catch { Log "No se pudo borrar $n en el servidor: $($_.Exception.Message)" }
          $estado.Remove($n); GuardarEstado
        }
      }
    }
  } catch { Log "Error en la vuelta: $($_.Exception.Message)" }
  Start-Sleep -Seconds $intervalo
}
