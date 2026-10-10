$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'assets\animation\tagmaid-sorting-source.png'
$outputDirectory = Join-Path $projectRoot 'extension\images'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$sourceImage = [System.Drawing.Bitmap]::new($sourcePath)
try {
    if ($sourceImage.Width % 3 -ne 0 -or $sourceImage.Height % 2 -ne 0) { throw '原始图集必须是等分的 3 列、2 行。' }
    $cellWidth = [int]($sourceImage.Width / 3)
    $cellHeight = [int]($sourceImage.Height / 2)
    if ($cellWidth -ne $cellHeight) { throw '原始动画帧必须为正方形。' }
    # 以显示尺寸的两倍输出，供高分屏使用；原始图集单独保留。
    $frameSize = 192
    $strip = [System.Drawing.Bitmap]::new(($frameSize * 6), $frameSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($strip)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        for ($frame = 0; $frame -lt 6; $frame++) {
            $sourceX = ($frame % 3) * $cellWidth
            $sourceY = [int][Math]::Floor($frame / 3) * $cellHeight
            $graphics.DrawImage($sourceImage, [System.Drawing.Rectangle]::new(($frame * $frameSize), 0, $frameSize, $frameSize), $sourceX, $sourceY, $cellWidth, $cellHeight, [System.Drawing.GraphicsUnit]::Pixel)
        }
        $strip.Save((Join-Path $outputDirectory 'tagmaid-sorting-strip.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $strip.Dispose()
    }
} finally {
    $sourceImage.Dispose()
}
Write-Output '已生成 6 帧透明动画条，单帧 192×192。'
