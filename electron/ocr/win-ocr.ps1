# Windows.Media.Ocr daemon (UTF-8 + BOM required for PS5.1 to read CJK literals correctly)
# Line protocol over stdio:
#   in :  { "id": "x", "path": "C:/tmp/xxx.png", "lang": "zh-Hans-CN" }
#   out:  { "id": "x", "ok": true, "text": "...", "lines": [...], "words": [...], "angle": 0 }
#   out:  { "id": "x", "ok": false, "error": "..." }

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Load Windows Runtime assemblies
try {
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
} catch {
    Write-Host (ConvertTo-Json -Compress -InputObject @{ ready = $false; error = "Failed to load Windows Runtime assemblies: $($_.Exception.Message)" })
    exit 1
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT IAsyncOperation<T> -> .NET Task<T> awaiter
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($winrtTask, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($winrtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

# Engine cache: one per LanguageTag (creating engines is non-trivial)
$engineCache = @{}

function Get-OcrEngine([string]$tag) {
    if ([string]::IsNullOrWhiteSpace($tag)) { $tag = 'zh-Hans-CN' }
    if ($engineCache.ContainsKey($tag)) { return $engineCache[$tag] }
    
    # Try exact language first
    $lang = New-Object Windows.Globalization.Language($tag)
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    
    if ($null -eq $eng) {
        # Try simplified Chinese fallback
        if ($tag -ne 'zh-Hans-CN') {
            $lang2 = New-Object Windows.Globalization.Language('zh-Hans-CN')
            $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang2)
        }
    }
    
    if ($null -eq $eng) {
        $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    
    if ($null -eq $eng) { 
        throw "Cannot create OCR engine (missing language pack: $tag). Please install Chinese (Simplified) language pack." 
    }
    
    $engineCache[$tag] = $eng
    return $eng
}

function Recognize-File([string]$path, [string]$lang) {
    $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        
        # Get software bitmap - Windows OCR works best with Bgra8 format
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        
        # Convert to Bgra8 premultiplied if needed for better OCR accuracy
        if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) {
            $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
                $bitmap, 
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
            )
            $bitmap.Dispose()
            $bitmap = $converted
        }
        
        $eng = Get-OcrEngine $lang
        $result = Await ($eng.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        $linesArr = @()
        $wordsArr = @()
        foreach ($line in $result.Lines) {
            $lineWords = @()
            foreach ($w in $line.Words) {
                $box = $w.BoundingRect
                $wordObj = [pscustomobject]@{
                    text = $w.Text
                    x = [int]$box.X
                    y = [int]$box.Y
                    w = [int]$box.Width
                    h = [int]$box.Height
                }
                $wordsArr += $wordObj
                $lineWords += $wordObj
            }
            $linesArr += [pscustomobject]@{
                text = $line.Text
                words = $lineWords
            }
        }
        $angle = 0.0
        if ($null -ne $result.TextAngle) { $angle = [double]$result.TextAngle }
        return [pscustomobject]@{
            text = $result.Text
            lines = $linesArr
            words = $wordsArr
            angle = $angle
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

# Handshake
Write-Host (ConvertTo-Json -Compress -InputObject @{ ready = $true; languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) })

# Main loop
while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $req = $null
    try { $req = ConvertFrom-Json $line } catch {
        Write-Host (ConvertTo-Json -Compress -InputObject @{ ok = $false; error = ("Invalid JSON: " + $_.Exception.Message) })
        continue
    }
    $id = $req.id
    if ($req.cmd -eq 'quit') { break }
    try {
        $r = Recognize-File $req.path $req.lang
        $payload = @{
            id = $id
            ok = $true
            text = $r.text
            lines = $r.lines
            words = $r.words
            angle = $r.angle
        }
        Write-Host (ConvertTo-Json -Compress -Depth 8 -InputObject $payload)
    } catch {
        Write-Host (ConvertTo-Json -Compress -InputObject @{ id = $id; ok = $false; error = $_.Exception.Message })
    }
}
