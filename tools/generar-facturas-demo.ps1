# Genera las facturas sintéticas de demo de Paridad (PNG) usando System.Drawing.
#
# Las imágenes generadas SÍ se versionan en el repo (demo-data/facturas/), así
# que este script solo hace falta para regenerarlas o crear variantes nuevas.
# Requiere Windows/.NET; los PNG resultantes son portables.
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools/generar-facturas-demo.ps1
#
# PARÁMETROS DE RENDER Y POR QUÉ ------------------------------------------
# El detector CRAFT del OCR de QVAC (OCR_LATIN) se midió sobre estas mismas
# facturas a varias escalas. A escala 1.0 (font 20) fallaba de forma
# reproducible en tres puntos:
#   - la cantidad "4" aislada no se detectaba en absoluto;
#   - "20W50" se leía "20h50";
#   - "47.00" se partía en dos bloques "47" y "00", perdiendo el decimal.
# Subir magRatio en el OCR NO lo arreglaba (solo triplicaba la latencia).
# Renderizar a escala 2.1 sí: los tres se leen correctamente. Por eso las
# imágenes se generan grandes. Ver README para el detalle.
# --------------------------------------------------------------------------

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\demo-data\facturas"
New-Item -ItemType Directory -Force $outDir | Out-Null

$s = 2.1  # escala de render (ver nota arriba)

# Datos SINTÉTICOS. Negocios, RUC, clientes y proveedores son inventados.
# Los precios unitarios coinciden con DEMO_PRICES de p2p-privacy-test.mjs
# (4700 / 3100 / 5200 centavos) para poder encadenar los dos spikes después.
$facturas = @(
  @{ archivo = "factura-demo-a.png"; proveedor = "DISTRIBUIDORA EL PROGRESO"; ruc = "RUC 155-DEMO-A"; numero = "000123"; fecha = "12/03/2026"; cliente = "TALLER LA ESQUINA"; cant = 4; desc = "ACEITE MOTOR 20W50"; unit = "47.00"; total = "188.00" },
  @{ archivo = "factura-demo-b.png"; proveedor = "SUMINISTROS CENTRAL"; ruc = "RUC 155-DEMO-B"; numero = "004871"; fecha = "14/03/2026"; cliente = "AUTOSERVICIO MIRAFLORES"; cant = 6; desc = "ACEITE MOTOR 20W50"; unit = "31.00"; total = "186.00" },
  @{ archivo = "factura-demo-c.png"; proveedor = "IMPORTADORA SAN JOSE"; ruc = "RUC 155-DEMO-C"; numero = "091245"; fecha = "15/03/2026"; cliente = "LUBRICENTRO DEL SUR"; cant = 3; desc = "ACEITE MOTOR 20W50"; unit = "52.00"; total = "156.00" }
)

function Px([double]$v) { return [int]($v * $s) }

foreach ($f in $facturas) {
  $w = Px 1000
  $h = Px 560
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)

  # Sin antialiasing de texto: bordes duros = OCR más estable.
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit

  $fTitulo = New-Object System.Drawing.Font("Consolas", (26 * $s))
  $fNormal = New-Object System.Drawing.Font("Consolas", (20 * $s))
  $fBold = New-Object System.Drawing.Font("Consolas", (20 * $s), [System.Drawing.FontStyle]::Bold)
  $negro = [System.Drawing.Brushes]::Black
  $lapiz = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, (2 * $s))
  $m = Px 40

  $y = Px 30
  $g.DrawString($f.proveedor, $fTitulo, $negro, $m, $y); $y += Px 52
  $g.DrawString($f.ruc, $fNormal, $negro, $m, $y); $y += Px 42
  $g.DrawString("FACTURA No. $($f.numero)", $fBold, $negro, $m, $y); $y += Px 36
  $g.DrawString("FECHA: $($f.fecha)", $fNormal, $negro, $m, $y); $y += Px 36
  $g.DrawString("CLIENTE: $($f.cliente)", $fNormal, $negro, $m, $y); $y += Px 50

  $g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 14
  $g.DrawString("CANT     DESCRIPCION", $fBold, $negro, $m, $y); $y += Px 36
  $g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 14

  # La cantidad se escribe "4 UND" y no "4": a escala 1.0 el glifo suelto no
  # se detectaba, y "4 UND" es además como aparece en facturas reales.
  $g.DrawString("$($f.cant) UND    $($f.desc)", $fNormal, $negro, $m, $y); $y += Px 44

  # Precio unitario y total en líneas etiquetadas en vez de columnas anchas:
  # las columnas separadas por mucho espacio horizontal se leían peor.
  $g.DrawString("PRECIO UNITARIO: $($f.unit)", $fNormal, $negro, $m, $y); $y += Px 40
  $g.DrawString("TOTAL A PAGAR:   $($f.total)", $fBold, $negro, $m, $y); $y += Px 50

  $g.DrawLine($lapiz, $m, $y, ($w - $m), $y); $y += Px 16
  $g.DrawString("DOCUMENTO SINTETICO DE DEMO - PARIDAD", $fNormal, $negro, $m, $y)

  $ruta = Join-Path $outDir $f.archivo
  $bmp.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose(); $bmp.Dispose(); $lapiz.Dispose()
  $fTitulo.Dispose(); $fNormal.Dispose(); $fBold.Dispose()
  Write-Output "generada: $ruta ($w x $h)"
}
