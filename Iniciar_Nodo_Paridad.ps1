# Arranca UN participante de Paridad: lee su factura con QVAC (local, sin
# nube), se conecta a las otras 2 laptops por la red local (sin Internet) y
# abre su panel de benchmark en el navegador.
#
# Corre esto en CADA una de las 3 laptops participantes (incluida la que
# tambien esta corriendo el bootstrap, si aplica).

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "=== Paridad - Nodo participante ===" -ForegroundColor Cyan
Write-Host ""

do {
    $nombre = (Read-Host "Nombre de este nodo (A, B o C)").ToUpper().Trim()
} while ($nombre -notin @("A", "B", "C"))

Write-Host ""
$facturaDefault = "demo-data\facturas\factura-demo-$($nombre.ToLower()).png"
$factura = Read-Host "Ruta a la imagen de la factura (Enter para usar la de demo: $facturaDefault)"
if ([string]::IsNullOrWhiteSpace($factura)) { $factura = $facturaDefault }
$factura = $factura.Trim('"')

if (-not (Test-Path $factura)) {
    Write-Host "No se encontro el archivo: $factura" -ForegroundColor Red
    Read-Host "Presiona Enter para salir"
    exit 1
}

Write-Host ""
Write-Host "Direccion del bootstrap (te la dio la laptop que corrio Iniciar_Bootstrap_Paridad.ps1)" -ForegroundColor Yellow
$bootstrapInput = Read-Host "Formato IP:PUERTO, ej. 192.168.1.50:49738"
$bootstrapInput = $bootstrapInput.Trim()

$partes = $bootstrapInput -split ":"
if ($partes.Count -ne 2) {
    Write-Host "Formato invalido. Debe ser IP:PUERTO." -ForegroundColor Red
    Read-Host "Presiona Enter para salir"
    exit 1
}
$bootstrapHost = $partes[0]
$bootstrapPort = $partes[1]
$bootstrapJson = "[{`"host`":`"$bootstrapHost`",`"port`":$bootstrapPort}]"

# Mismo topic en las 3 laptops para que se encuentren en el mismo "canal".
# Fijo por defecto para no tener que coordinarlo a mano; cambialo si vas a
# correr dos demos distintas en la misma red al mismo tiempo.
$topic = Read-Host "Topic de la ronda (Enter para usar el de demo: paridad-hackathon-demo)"
if ([string]::IsNullOrWhiteSpace($topic)) { $topic = "paridad-hackathon-demo" }

Write-Host ""
Write-Host "Arrancando nodo $nombre..." -ForegroundColor Green
Write-Host "  Factura:   $factura"
Write-Host "  Bootstrap: $bootstrapHost`:$bootstrapPort"
Write-Host "  Topic:     $topic"
Write-Host ""
Write-Host "La UI se abrira en http://localhost:4700 en unos segundos (carga de QVAC ~10-30s)." -ForegroundColor DarkGray
Write-Host "No cierres esta ventana durante la demo. Ctrl+C para detener." -ForegroundColor DarkGray
Write-Host ""

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 6
    Start-Process "http://localhost:4700"
} | Out-Null

node nodo-paridad.mjs $nombre --port 4700 --topic $topic --bootstrap $bootstrapJson --factura $factura --ocr-backend cpu

Read-Host "El nodo se detuvo. Presiona Enter para cerrar"
