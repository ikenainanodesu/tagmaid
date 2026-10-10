param([switch]$DeepSeek)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'assets\logo\tagmaid-pixel-v1.png'
$prefix = 'icon-'
if ($DeepSeek) {
    $sourcePath = Join-Path $projectRoot 'assets\logo\tagmaid-deepseek-v1.png'
    $prefix = 'deepseek-'
}
$outputDirectory = Join-Path $projectRoot 'extension\icons'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$sourceImage = [System.Drawing.Bitmap]::new($sourcePath)
try {
    foreach ($size in @(16, 24, 32, 48, 96, 128)) {
        $icon = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($icon)
        try {
            # 最近邻采样保留像素边缘，同时保留原图透明通道。
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $graphics.DrawImage($sourceImage, [System.Drawing.Rectangle]::new(0, 0, $size, $size), 0, 0, $sourceImage.Width, $sourceImage.Height, [System.Drawing.GraphicsUnit]::Pixel)
            $icon.Save((Join-Path $outputDirectory "$prefix$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $icon.Dispose()
        }
    }
} finally {
    $sourceImage.Dispose()
}
Write-Output '已生成 16、24、32、48、96、128 像素透明图标。'
