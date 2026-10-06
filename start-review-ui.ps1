$ErrorActionPreference = 'Stop'
$reviewUiDirectory = Join-Path $PSScriptRoot 'web-ui'
if (-not (Test-Path -LiteralPath (Join-Path $reviewUiDirectory 'node_modules'))) {
    & npm.cmd --prefix $reviewUiDirectory ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& npm.cmd --prefix $reviewUiDirectory run dev
exit $LASTEXITCODE
