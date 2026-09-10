# Arranca el nodo "bootstrap" de Paridad: SOLO sirve para que las otras
# laptops se descubran entre si por la red local (Wi-Fi), sin usar el DHT
# publico de Internet. No participa en el protocolo, no ve precios ni
# facturas.
#
# Corre esto en UNA sola laptop (la que haga de "ancla" de la demo).
# Las otras dos laptops NO necesitan este script, solo la direccion que
# este script les va a mostrar.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "=== Paridad - Nodo Bootstrap (descubrimiento LAN) ===" -ForegroundColor Cyan
Write-Host ""

$puerto = 49738

$ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" } |
    Select-Object -ExpandProperty IPAddress -First 1

if (-not $ip) {
    Write-Host "No se detecto ninguna IP de red local. Conectate al Wi-Fi/LAN de la demo y vuelve a intentar." -ForegroundColor Red
    Read-Host "Presiona Enter para salir"
    exit 1
}

Write-Host "Esta laptop hara de ancla de descubrimiento en:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    $ip`:$puerto" -ForegroundColor Green
Write-Host ""
Write-Host "Dale esa direccion a las otras 2 laptops - la van a pegar cuando" -ForegroundColor Yellow
Write-Host "'Iniciar_Nodo_Paridad.ps1' les pregunte por el bootstrap." -ForegroundColor Yellow
Write-Host ""
Write-Host "No cierres esta ventana durante la demo. Ctrl+C para detener." -ForegroundColor DarkGray
Write-Host ""

node paridad-bootstrap.mjs --host $ip --port $puerto

Read-Host "El bootstrap se detuvo. Presiona Enter para cerrar"
