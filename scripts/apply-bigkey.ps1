# Point the D200's wide key (slot 3_2) at this plugin's Session Board.
#
# Ulanzi Studio has no way to drag an action onto that slot, and it clears
# whatever is there whenever the page is edited in its UI -- so the profile
# JSON is patched directly. Re-run this if the board ever goes blank after
# rearranging keys.
#
#   powershell -ExecutionPolicy Bypass -File scripts\apply-bigkey.ps1
#
# Pass -Revert to hand the slot back to whatever Ulanzi had there.

param(
    [switch]$Revert
)

$ErrorActionPreference = 'Stop'

$base = Join-Path $env:APPDATA 'Ulanzi\UlanziDeck'
$slot = '3_2'
$pluginUuid = 'com.ulanzi.ulanzistudio.claudeapprover'
$actionUuid = "$pluginUuid.board"

if (Get-Process -Name 'Ulanzi Studio' -ErrorAction SilentlyContinue) {
    throw 'Quit Ulanzi Studio first - it rewrites these files on exit and would undo the patch.'
}

$settingPath = Join-Path $base 'Config\setting_source.json'
if (-not (Test-Path $settingPath)) { throw "No Ulanzi config at $settingPath" }
$setting = Get-Content $settingPath -Raw | ConvertFrom-Json

$patched = 0
foreach ($device in $setting.Devices) {
    $profileName = $device.CurrentProfile
    $deviceUuid = $device.CurrentDevice

    foreach ($group in Get-ChildItem (Join-Path $base 'ProfilesV2') -Directory) {
        $groupManifest = Join-Path $group.FullName 'manifest.json'
        if (-not (Test-Path $groupManifest)) { continue }
        $g = Get-Content $groupManifest -Raw | ConvertFrom-Json
        if ($g.Name -ne $profileName -or $g.Device.UUID -ne $deviceUuid) { continue }

        $page = $g.Pages.Current
        if (-not $page) { continue }
        $pagePath = Join-Path $group.FullName "Profiles\$page\manifest.json"
        if (-not (Test-Path $pagePath)) { continue }

        $p = Get-Content $pagePath -Raw | ConvertFrom-Json
        foreach ($controller in $p.Controllers) {
            if ($controller.Type -ne 'Keypad') { continue }

            $current = $controller.Actions.$slot
            if ($Revert) {
                if ($current -and $current.Action -eq $actionUuid) {
                    $controller.Actions.PSObject.Properties.Remove($slot)
                    Copy-Item $pagePath "$pagePath.bak-bigkey" -Force
                    ($p | ConvertTo-Json -Depth 30) | Set-Content $pagePath -Encoding UTF8
                    Write-Host "$profileName : big key cleared" -ForegroundColor Green
                    $patched++
                }
                continue
            }

            if ($current -and $current.Action -eq $actionUuid) {
                Write-Host "$profileName : big key is already the Session Board"
                continue
            }

            $icon = Join-Path $base "Plugins\$pluginUuid.ulanziPlugin\assets\icons\session.svg"
            $entry = [ordered]@{
                Action      = $actionUuid
                ActionID    = [guid]::NewGuid().ToString()
                ActionParam = @{}
                LinkedTitle = $true
                Name        = 'Session Board'
                Plugin      = @{
                    Name    = 'Claude Code Approver'
                    UUID    = $pluginUuid
                    Version = '1.8.0'
                }
                State       = 0
                ViewParam   = @(@{ Icon = $icon; IconRel = '' })
            }

            Copy-Item $pagePath "$pagePath.bak-bigkey" -Force
            if ($controller.Actions.PSObject.Properties[$slot]) {
                $controller.Actions.$slot = $entry
            } else {
                $controller.Actions | Add-Member -NotePropertyName $slot -NotePropertyValue $entry
            }
            ($p | ConvertTo-Json -Depth 30) | Set-Content $pagePath -Encoding UTF8
            Write-Host "$profileName : big key -> Session Board (backup $pagePath.bak-bigkey)" -ForegroundColor Green
            $patched++
        }
    }
}

if ($patched -eq 0) {
    Write-Host 'Nothing to patch - no active profile matched.' -ForegroundColor Yellow
} else {
    Write-Host 'Start Ulanzi Studio. Editing that page in the UI will clear the slot again; re-run this if so.'
}
