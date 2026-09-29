/** Runs after yt-dlp finishes, including when it reuses an existing download.
 * Only publishes the import marker after codec validation/conversion succeeds.
 * ffmpeg is also the probe, so no separate ffprobe installation is needed.
 */
export const premiereMediaUnix = String.raw`#!/bin/bash
set -eu
SOURCE="$1"
FFMPEG="\${FRAMELAB_FFMPEG:-}"
if [ -z "$FFMPEG" ]; then echo 'ERROR: falta o ffmpeg para preparar o video para o Premiere.' >&2; exit 1; fi
INFO="$("$FFMPEG" -hide_banner -i "$SOURCE" 2>&1 || true)"
VIDEO="$(printf '%s\n' "$INFO" | sed -n 's/.*Stream.*Video: \([^ ,]*\).*/\1/p' | head -n 1)"
AUDIO="$(printf '%s\n' "$INFO" | sed -n 's/.*Stream.*Audio: \([^ ,]*\).*/\1/p' | head -n 1)"
if [ -z "$VIDEO" ]; then echo 'ERROR: nao foi possivel validar o video baixado.' >&2; exit 1; fi
VARGS=(-c:v copy)
if [ "$VIDEO" != h264 ] || ! printf '%s\n' "$INFO" | grep -Eq 'Video:.* yuv420p[,( ]'; then
  VARGS=(-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p)
fi
AARGS=(-c:a copy)
if [ -n "$AUDIO" ] && [ "$AUDIO" != aac ]; then AARGS=(-c:a aac -b:a 192k); fi
if [ "\${VARGS[1]}" != copy ] || [ "\${AARGS[1]}" != copy ]; then
  echo '[Framelab] Preparando video compativel com o Premiere (H.264/AAC)...'
  STAGE="$(mktemp -d "\${SOURCE}.framelab.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  "$FFMPEG" -nostdin -hide_banner -y -i "$SOURCE" -map 0:v:0 -map '0:a:0?' \
    "\${VARGS[@]}" "\${AARGS[@]}" -movflags +faststart -f mp4 "$STAGE/ready.mp4"
  mv -f "$STAGE/ready.mp4" "$SOURCE"
fi
JSON="$SOURCE"
JSON="\${JSON//\\/\\\\}"
JSON="\${JSON//\"/\\\"}"
JSON="\${JSON//$'\n'/\\n}"
JSON="\${JSON//$'\r'/\\r}"
JSON="\${JSON//$'\t'/\\t}"
JSON="\${JSON//$'\b'/\\b}"
JSON="\${JSON//$'\f'/\\f}"
printf 'FRAMELAB_FILE:"%s"\n' "$JSON"
`.replace(/\\\$/g, "$");

export const premiereMediaWin = String.raw`param([string]$Source)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$Stage = $null
try {
  $ffmpeg = $env:FRAMELAB_FFMPEG
  if (!$ffmpeg) { throw 'Falta o ffmpeg para preparar o video para o Premiere.' }
  $ErrorActionPreference = 'Continue'
  $info = (& $ffmpeg -hide_banner -i $Source 2>&1 | Out-String)
  $ErrorActionPreference = 'Stop'
  $video = [regex]::Match($info, 'Stream[^\r\n]*Video: ([^ ,]+)').Groups[1].Value
  $audio = [regex]::Match($info, 'Stream[^\r\n]*Audio: ([^ ,]+)').Groups[1].Value
  if (!$video) { throw 'Nao foi possivel validar o video baixado.' }
  $vargs = @('-c:v', 'copy')
  if ($video -ne 'h264' -or $info -notmatch 'Video:[^\r\n]* yuv420p[,( ]') {
    $vargs = @('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p')
  }
  $aargs = @('-c:a', 'copy')
  if ($audio -and $audio -ne 'aac') { $aargs = @('-c:a', 'aac', '-b:a', '192k') }
  if ($vargs[1] -ne 'copy' -or $aargs[1] -ne 'copy') {
    Write-Output '[Framelab] Preparando video compativel com o Premiere (H.264/AAC)...'
    $Stage = $Source + '.framelab.' + [guid]::NewGuid().ToString('N')
    New-Item -ItemType Directory -Path $Stage | Out-Null
    $ready = Join-Path $Stage 'ready.mp4'
    & $ffmpeg -nostdin -hide_banner -y -i $Source -map 0:v:0 -map '0:a:0?' @vargs @aargs -movflags +faststart -f mp4 $ready
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao converter o video para o Premiere.' }
    Move-Item -Force -LiteralPath $ready -Destination $Source
  }
  Write-Output ('FRAMELAB_FILE:' + (ConvertTo-Json -Compress -InputObject $Source))
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -Recurse -Force -LiteralPath $Stage }
}
exit 0
`;
