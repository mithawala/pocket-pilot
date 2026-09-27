# Publishes Pocket Pilot to GitHub:
#  1. creates the public repo (if needed) and pushes main,
#  2. builds the site (landing page at /, phone app at /app/) and publishes it to the gh-pages branch,
#  3. builds the VSIX and attaches it to the GitHub release v<version> (as pocket-pilot.vsix, which the
#     landing page links to via releases/latest/download/pocket-pilot.vsix).
# Needs only the default `repo` scope (no `workflow` scope):
#   gh auth login --hostname github.com --git-protocol https --web   # once, with the account that owns the repo
#   pwsh scripts/publish.ps1 [-Owner mithawala] [-Repo pocket-pilot] [-Node node]
param(
  [string]$Owner = 'mithawala',
  [string]$Repo = 'pocket-pilot',
  [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$previous = (gh api user --jq .login 2>$null)
if ($previous -ne $Owner) {
  gh auth switch --hostname github.com --user $Owner | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Log in first: gh auth login --hostname github.com --git-protocol https --web (as $Owner)" }
}
$git = @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential')
try {
  $slug = "$Owner/$Repo"
  $siteUrl = "https://$Owner.github.io/$Repo/"
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version

  Write-Host "Building site and VSIX (v$version)…"
  $env:PP_SITE_URL = $siteUrl
  & $Node scripts/build-site.mjs
  if ($LASTEXITCODE -ne 0) { throw 'build-site failed' }
  & $Node scripts/package-vsix.mjs
  if ($LASTEXITCODE -ne 0) { throw 'package-vsix failed' }
  $vsix = "pocket-pilot-$version.vsix"
  Copy-Item $vsix dist/pocket-pilot.vsix -Force

  gh repo view $slug --json name 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating $slug…"
    gh repo create $slug --public --description 'Control your VS Code agent sessions (GitHub Copilot, Claude) from your phone. Free, end-to-end encrypted, passkey-protected.' --homepage $siteUrl | Out-Null
  }
  if (-not (git remote 2>$null | Select-String -Quiet '^origin$')) { git remote add origin "https://github.com/$slug.git" }

  Write-Host 'Pushing main…'
  git @git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw 'git push (main) failed' }
  $head = (git rev-parse --short HEAD).Trim()

  Write-Host 'Publishing dist/site to gh-pages…'
  $site = (Resolve-Path dist/site).Path
  $name = (git config user.name); $email = (git config user.email)
  if (Test-Path "$site/.git") { Remove-Item -Recurse -Force "$site/.git" }
  git -C $site init -q -b gh-pages
  git -C $site add -A
  git -C $site -c "user.name=$name" -c "user.email=$email" commit -q -m "Publish site from $head"
  git @git -C $site push --force "https://github.com/$slug.git" gh-pages:gh-pages
  $pushed = $LASTEXITCODE
  Remove-Item -Recurse -Force "$site/.git"
  if ($pushed -ne 0) { throw 'git push (gh-pages) failed' }

  Write-Host 'Configuring GitHub Pages (gh-pages branch)…'
  gh api -X POST "repos/$slug/pages" -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' 2>$null | Out-Null
  gh api -X PUT "repos/$slug/pages" -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' 2>$null | Out-Null
  gh api -X POST "repos/$slug/pages/builds" 2>$null | Out-Null
  gh repo edit $slug --homepage $siteUrl 2>$null | Out-Null

  Write-Host "Publishing release v$version…"
  gh release view "v$version" --repo $slug --json tagName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    gh release upload "v$version" dist/pocket-pilot.vsix $vsix --repo $slug --clobber
  } else {
    $notes = @"
Install: download **pocket-pilot.vsix**, then in VS Code run **Extensions → ··· → Install from VSIX…** (or ``code --install-extension pocket-pilot.vsix``).

Phone app: $($siteUrl)app/ · Product page: $siteUrl
"@
    gh release create "v$version" dist/pocket-pilot.vsix $vsix --repo $slug --target main --title "Pocket Pilot $version" --notes $notes
  }
  if ($LASTEXITCODE -ne 0) { throw 'gh release failed' }

  $check = "$($siteUrl)app/manifest.webmanifest"
  Write-Host "Waiting for $check …"
  $code = ''
  for ($i = 0; $i -lt 60; $i++) {
    $code = curl.exe -sS -o NUL -w '%{http_code}' "$check`?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" 2>$null
    if ($code -eq '200') { Write-Host "Live: $siteUrl (app: $($siteUrl)app/)"; break }
    Start-Sleep -Seconds 10
  }
  if ($code -ne '200') { Write-Warning 'The site is not live yet; check Settings → Pages of the repository.' }
} finally {
  Remove-Item Env:PP_SITE_URL -ErrorAction SilentlyContinue
  if ($previous -and $previous -ne $Owner) { gh auth switch --hostname github.com --user $previous | Out-Null }
}
