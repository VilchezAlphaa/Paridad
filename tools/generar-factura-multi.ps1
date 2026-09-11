# Genera la factura de demo con VARIOS productos (demo-data/facturas/
# factura-demo-multi.png). Complementa a generar-facturas-demo.ps1, que
# produce facturas de una sola linea; este script no toca esas.
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools/generar-factura-multi.ps1
#
# Layout deliberadamente "OCR-friendly": cada linea lleva su precio pegado a la
# etiqueta P.UNIT, sin columnas anchas. Con columnas separadas por mucho
# espacio horizontal el detector partia "47.00" en "47" y "00" (medido en
# tools/bench-ocr.mjs). Escala 1.4 y "N UND", como en las de una linea.

param(
  [double]$Escala = 1.4,
  [string]$OutDir = ""
)

Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $PSScriptRoot "..\demo-data\facturas"
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

$s = $Escala
function Px([double]$v) { return [int]($v * $s) }

# Datos SINTETICOS. Los precios coinciden con los del nodo A de demo-items.mjs
# para poder contrastar la extraccion contra valores conocidos.
$lineas = @(
  @{ cant = 4;  desc = "ACEITE MOTOR 20W50";        unit = "47.00" },
  @{ cant = 12; desc = "FILTRO DE ACEITE";           unit = "6.80" },
  @{ cant = 6;  desc = "PASTILLAS DE FRENO DELANT";  unit = "28.50" },
  @{ cant = 2;  desc = "BATERIA 12V 650A";           unit = "78.00" },
  @{ cant = 8;  desc = "BUJIAS DE ENCENDIDO X4";     unit = "16.40" }
)

$w = Px 1000
$h = Px 640
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit

$fTitulo = New-Object System.Drawing.Font("Consolas", (26 * $s))
$fNormal = New-Object System.Drawing.Font("Consolas", (20 * $s))
$fBold = New-Object System.Drawing.Font("Consolas", (20 * $s), [System.Drawing.FontStyle]::Bold)
$negro = [System.Drawing.Brushes]::Black
$lapiz = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, (2 * $s))
$m = Px 40

$y = Px 30
$g.DrawString("DISTRIBUIDORA EL PROGRESO", $fTitulo, $negro, $m, $y); $y += Px 52
$g.DrawString("RUC 155-DEMO-A", $fNormal, $negro, $m, $y); $y += Px 42
$g.DrawString("FACTURA No. 000124", $fBold, $negro, $m, $y); $y += Px 36
$g.DrawString("FECHA: 19/03/2026", $fNormal, $negro, $m, $y); $y += Px 36
$g.DrawString("CLIENTE: TALLER LA ESQUINA", $fNormal, $negro, $m, $y); $y += Px 46

$g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 12
$g.DrawString("CANT     DESCRIPCION                 P.UNIT", $fBold, $negro, $m, $y); $y += Px 34
$g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 12

$total = 0.0
foreach ($l in $lineas) {
  $texto = "{0,-8} {1,-28} P.UNIT {2}" -f "$($l.cant) UND", $l.desc, $l.unit
  $g.DrawString($texto, $fNormal, $negro, $m, $y); $y += Px 36
  $total += $l.cant * [double]::Parse($l.unit, [Globalization.CultureInfo]::InvariantCulture)
}

$y += Px 8
$g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 14
$totalTexto = $total.ToString("0.00", [Globalization.CultureInfo]::InvariantCulture)
$g.DrawString("TOTAL A PAGAR:   $totalTexto", $fBold, $negro, $m, $y); $y += Px 44
$g.DrawString("DOCUMENTO SINTETICO DE DEMO - PARIDAD", $fNormal, $negro, $m, $y)

$ruta = Join-Path $OutDir "factura-demo-multi.png"
$bmp.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $lapiz.Dispose(); $fTitulo.Dispose(); $fNormal.Dispose(); $fBold.Dispose()
Write-Output "generada: $ruta ($w x $h)"
