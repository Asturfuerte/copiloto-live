# Matilde Sync: vigila una carpeta del PC y sube a Copiloto Live todo documento nuevo o modificado.
# Uso: doble clic en matilde-sync.bat (deja la ventana abierta mientras quieras que vigile).
# Configuración en matilde-sync.json, junto a este script:
#   { "url": "https://live.asturfuerte.es", "pin": "1234", "carpeta": "C:\\Users\\Alfredo\\Desktop\\Matilde\\subir", "intervalo": 10, "borrarRemoto": false }
# - url: dirección de Copiloto Live del cliente
# - pin: el mismo PIN con el que se entra en la web
# - carpeta: lo que se deje aquí se sube (pdf, docx, md, txt). Las subcarpetas no se miran.
# - intervalo: segundos entre comprobaciones
# - borrarRemoto: si true, al quitar un fichero de la carpeta también se borra de Copiloto Live

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $aqui 'matilde-sync.json'
if (-not (Test-Path $cfgPath)) { Write-Host "Falta $cfgPath"; exit 1 }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$url = $cfg.url.TrimEnd('/')
$pin = [string]$cfg.pin
$carpeta = $cfg.carpeta
$intervalo = if ($cfg.intervalo) { [int]$cfg.intervalo } else { 10 }
$borrarRemoto = [bool]$cfg.borrarRemoto
$estadoPath = Join-Path $aqui 'matilde-sync.estado.json'
$logPath = Join-Path $aqui 'matilde-sync.log'
$ext = @('.pdf', '.docx', '.md', '.txt')

if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Path $carpeta | Out-Null }

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

# Tamaño visto en la vuelta anterior, para no subir ficheros que aún se están copiando
$visto = @{}

Log "Matilde Sync vigilando $carpeta -> $url (cada $intervalo s). Ctrl+C para parar."
try { $s = Invoke-RestMethod -Uri "$url/salud" -TimeoutSec 15; Log ("Servidor OK: agente '{0}', {1} documento(s) cargado(s)." -f $s.nombre, @($s.documentos).Count) } catch { Log "Aviso: no se pudo consultar $url/salud ($($_.Exception.Message))" }

while ($true) {
  try {
    $ficheros = Get-ChildItem -Path $carpeta -File | Where-Object { $ext -contains $_.Extension.ToLower() -and -not $_.Name.StartsWith('.') -and -not $_.Name.StartsWith('~$') }
    $nombres = @{}
    foreach ($f in $ficheros) {
      $nombres[$f.Name] = $true
      $firma = "{0}|{1}" -f $f.Length, $f.LastWriteTimeUtc.Ticks
      if ($estado[$f.Name] -eq $firma) { continue }
      # Esperar a que el fichero deje de crecer (copias en curso, descargas)
      if ($visto[$f.Name] -ne $firma) { $visto[$f.Name] = $firma; continue }
      Log "Subiendo $($f.Name) ($([math]::Round($f.Length/1KB)) KB)..."
      try {
        $r = Invoke-RestMethod -Uri "$url/documentos/$(Enc $f.Name)?pin=$(Enc $pin)" -Method Put -InFile $f.FullName -ContentType 'application/octet-stream' -TimeoutSec 900
        $extra = if ($r.documento.ocr) { ', con OCR' } else { '' }
        Log ("  OK: {0} ({1} fragmentos{2}). Matilde ya puede consultarlo." -f $r.documento.fichero, $r.documento.fragmentos, $extra)
        $estado[$f.Name] = $firma; GuardarEstado
      } catch {
        $detalle = $_.Exception.Message
        try { $detalle = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
        Log "  ERROR al subir $($f.Name): $detalle"
        $estado[$f.Name] = "error|$firma"; GuardarEstado   # no reintentar hasta que cambie el fichero
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
