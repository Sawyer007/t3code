param()

$ErrorActionPreference = 'Stop'
$patchCheckout = Split-Path -Parent $PSScriptRoot

function Invoke-PatchGit {
    param([string]$Checkout, [string[]]$GitArguments)
    & git -C $Checkout @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "Git failed in $Checkout. Resolve the reported problem before continuing." }
}

$commonDirectory = Invoke-PatchGit $patchCheckout @('rev-parse', '--path-format=absolute', '--git-common-dir')
$mainCheckout = Split-Path -Parent $commonDirectory
foreach ($checkout in @($mainCheckout, $patchCheckout)) {
    if (Invoke-PatchGit $checkout @('status', '--porcelain')) {
        throw "Commit or preserve changes in $checkout before updating."
    }
    foreach ($operation in @('rebase-merge', 'rebase-apply', 'MERGE_HEAD')) {
        $operationPath = Invoke-PatchGit $checkout @('rev-parse', '--path-format=absolute', '--git-path', $operation)
        if (Test-Path -LiteralPath $operationPath) { throw "Finish the existing Git operation in $checkout first." }
    }
}
if ((Invoke-PatchGit $mainCheckout @('branch', '--show-current')) -ne 'main' -or
    (Invoke-PatchGit $patchCheckout @('branch', '--show-current')) -ne 'local/auto-handoff') {
    throw 'Run this from the local/auto-handoff worktree, with main checked out separately.'
}
$vp = Join-Path $patchCheckout 'node_modules/.bin/vp.cmd'
if (!(Test-Path $vp)) { throw 'Install the worktree dependencies before updating.' }

Invoke-PatchGit $mainCheckout @('fetch', 'upstream', 'main')
$backup = 'backup/auto-handoff-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
Invoke-PatchGit $patchCheckout @('branch', $backup)
Invoke-PatchGit $mainCheckout @('merge', '--ff-only', 'upstream/main')
Invoke-PatchGit $patchCheckout @('rebase', 'main')

Push-Location $patchCheckout
try {
    & $vp install --frozen-lockfile -- --yes
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & $vp test run apps/server/src/orchestration-v2/usageLimitHandoff.test.ts apps/server/src/orchestration-v2/runtimeLayer.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts packages/contracts/src/settings.test.ts -t 'automatic usage-limit|usage-limit recovery|usage-limit handoff settings|projects only the latest failed root'
    if ($LASTEXITCODE -ne 0) { throw 'Automatic handoff checks failed.' }
    & $vp test run packages/client-runtime/src/handoff.test.ts packages/client-runtime/src/state/sharedSettings.test.ts apps/web/src/components/settings/settingsSearch.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Handoff settings checks failed.' }
    foreach ($project in @('packages/contracts', 'packages/client-runtime', 'apps/server', 'apps/web', 'apps/mobile')) {
        & (Join-Path $patchCheckout 'node_modules/.bin/tsc-rs.cmd') --noEmit -p "$project/tsconfig.json"
        if ($LASTEXITCODE -ne 0) { throw "Typecheck failed for $project." }
    }
    $changedSources = @(Invoke-PatchGit $patchCheckout @('diff', '--name-only', 'main...HEAD', '--', '*.ts', '*.tsx'))
    if ($changedSources.Count -gt 0) {
        & $vp lint @changedSources
        if ($LASTEXITCODE -ne 0) { throw 'Lint failed for the patch.' }
    }
    Write-Host "Updated and checked. Previous patch is preserved at $backup. Build and run from $patchCheckout."
}
finally { Pop-Location }
