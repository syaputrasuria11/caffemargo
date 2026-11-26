# serve.ps1 — server statis sederhana (tanpa Node/Python) untuk menjalankan
# situs Caffe Margo + Web Kasir pada SATU origin, sehingga keduanya terhubung
# lewat localStorage/BroadcastChannel (lihat shared/orders.js).
#
#   PowerShell:  .\serve.ps1                 # http://localhost:8080/
#                .\serve.ps1 -Port 3000
#
# Buka situs Caffe : http://localhost:8080/index.html
# Buka web kasir   : http://localhost:8080/kasir/index.html   (login admin)
param(
  [int]$Port = 8080,
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = "Stop"
$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\','/')

$mime = @{
  ".html"="text/html; charset=utf-8"; ".css"="text/css; charset=utf-8"; ".js"="application/javascript; charset=utf-8";
  ".mjs"="application/javascript; charset=utf-8"; ".json"="application/json; charset=utf-8"; ".map"="application/json; charset=utf-8";
  ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".gif"="image/gif"; ".svg"="image/svg+xml";
  ".webp"="image/webp"; ".ico"="image/x-icon"; ".woff"="font/woff"; ".woff2"="font/woff2"; ".ttf"="font/ttf";
  ".txt"="text/plain; charset=utf-8"; ".md"="text/markdown; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Error "Gagal membuka $prefix : $($_.Exception.Message). Coba port lain: .\serve.ps1 -Port 3000"
  return
}

Write-Host "Serving $rootFull"
Write-Host "  Caffe Margo : $prefix" "index.html"
Write-Host "  Web Kasir   : $prefix" "kasir/login.html  -> kasir setelah login admin"
Write-Host "Ctrl+C untuk berhenti."

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
      $rel = $rel.Replace('/', '\')
      $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))

      # cegah path traversal
      if (-not ($full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase))) {
        $ctx.Response.StatusCode = 403
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("Forbidden")
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      elseif ((Test-Path -LiteralPath $full -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $ctype = $mime[$ext]; if (-not $ctype) { $ctype = "application/octet-stream" }
        $ctx.Response.ContentType = $ctype
        $ctx.Response.Headers.Add("Cache-Control", "no-store")
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      else {
        $ctx.Response.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      try { $ctx.Response.StatusCode = 500 } catch {}
    } finally {
      try { $ctx.Response.Close() } catch {}
    }
  }
} finally {
  $listener.Stop(); $listener.Close()
}
