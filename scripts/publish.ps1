# Publishes Pocket Pilot to GitHub: creates the public repo (if needed), pushes main, publishes
# the phone app (pwa/) to the gh-pages branch and serves it with GitHub Pages.
# Needs only the default `repo` scope (no `workflow` scope):
#   gh auth login --hostname github.com --git-protocol https --web   # once, with the personal account
#   pwsh scripts/publish.ps1 [-Owner mithawala] [-Repo pocket-pilot]
param(
  [string]$Owner = 'mithawala',
  [string]$Repo = 'pocket-pilot'
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
  gh repo view $slug --json name 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating $slug…"
    gh repo create $slug --public --description 'Control your VS Code agent sessions (GitHub Copilot, Claude) from your phone. Free, end-to-end encrypted, passkey-protected.' --homepage "https://$Owner.github.io/$Repo/" | Out-Null
  }
  if (-not (git remote 2>$null | Select-String -Quiet '^origin$')) { git remote add origin "https://github.com/$slug.git" }

  Write-Host 'Pushing main…'
  git @git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw 'git push (main) failed' }

  Write-Host 'Publishing pwa/ to gh-pages…'
  $sha = git subtree split --prefix pwa
  if ($LASTEXITCODE -ne 0 -or -not $sha) { throw 'git subtree split failed' }
  git @git push --force origin "$($sha.Trim()):refs/heads/gh-pages"
  if ($LASTEXITCODE -ne 0) { throw 'git push (gh-pages) failed' }

  Write-Host 'Configuring GitHub Pages (gh-pages branch)…'
  gh api -X POST "repos/$slug/pages" -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' 2>$null | Out-Null
  gh api -X PUT "repos/$slug/pages" -f build_type=legacy -f 'source[branch]=gh-pages' -f 'source[path]=/' 2>$null | Out-Null

  $url = "https://$Owner.github.io/$Repo/manifest.webmanifest"
  Write-Host "Waiting for $url …"
  $code = ''
  for ($i = 0; $i -lt 60; $i++) {
    $code = curl.exe -sS -o NUL -w '%{http_code}' "$url`?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" 2>$null
    if ($code -eq '200') { Write-Host "Live: https://$Owner.github.io/$Repo/"; break }
    Start-Sleep -Seconds 10
  }
  if ($code -ne '200') { Write-Warning 'The site is not live yet; check Settings → Pages of the repository.' }
} finally {
  if ($previous -and $previous -ne $Owner) { gh auth switch --hostname github.com --user $previous | Out-Null }
}
