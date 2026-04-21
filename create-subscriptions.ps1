<#
.SYNOPSIS
    Creates Microsoft Graph subscriptions for Teams channel message notifications.
.DESCRIPTION
    Creates one subscription per channel that sends change notifications to
    the Azure Function webhook. Subscriptions last 3 days and are auto-renewed
    by the lifecycle notification handler.
.PARAMETER Force
    Recreate subscriptions even if they already exist.
#>

param(
    [switch]$Force
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$configPath = Join-Path $scriptDir "workflow.config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$subFile = Join-Path $scriptDir ".agents\state\graph-subscriptions.json"

$functionUrl = "https://func-teams-monitor.azurewebsites.net/api"
$clientState = "teams-monitor-webhook"

# Get an access token via az CLI
$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv 2>$null
if (-not $token) {
    Write-Host "ERROR: Could not get Graph API token. Run 'az login' first."
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
}

# Load existing subscriptions
$existingSubs = @{}
if ((Test-Path $subFile) -and -not $Force) {
    try { $existingSubs = Get-Content $subFile -Raw | ConvertFrom-Json -AsHashtable } catch {}
}

$newSubs = @{}

foreach ($channel in $config.channels) {
    Write-Host "Setting up subscription for $($channel.name)..."

    # Check if subscription exists and is still valid
    if ($existingSubs[$channel.channelId]) {
        $subId = $existingSubs[$channel.channelId].id
        try {
            $check = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/subscriptions/$subId" `
                -Headers $headers -Method GET -ErrorAction Stop
            $expiry = [DateTime]::Parse($check.expirationDateTime)
            if ($expiry -gt (Get-Date).AddHours(12)) {
                Write-Host "  Existing subscription valid until $expiry. Skipping."
                $newSubs[$channel.channelId] = @{ id = $subId; expirationDateTime = $check.expirationDateTime }
                continue
            }
            Write-Host "  Existing subscription expiring soon. Renewing..."
        } catch {
            Write-Host "  Existing subscription invalid. Creating new..."
        }
    }

    # Create new subscription
    $expirationDateTime = (Get-Date).AddDays(2).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.0000000Z")

    $body = @{
        changeType = "created"
        notificationUrl = "$functionUrl/graphNotifications"
        lifecycleNotificationUrl = "$functionUrl/lifecycleNotifications"
        resource = "/teams/$($config.teamId)/channels/$($channel.channelId)/messages"
        expirationDateTime = $expirationDateTime
        clientState = $clientState
    } | ConvertTo-Json

    try {
        $sub = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/subscriptions" `
            -Headers $headers -Method POST -Body $body -ContentType "application/json"

        Write-Host "  Created subscription $($sub.id), expires $($sub.expirationDateTime)"
        $newSubs[$channel.channelId] = @{
            id = $sub.id
            expirationDateTime = $sub.expirationDateTime
            channelName = $channel.name
        }
    } catch {
        $err = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
        Write-Host "  FAILED: $($err.error.message ?? $_)"
    }
}

# Save subscription state
$newSubs | ConvertTo-Json -Depth 5 | Out-File $subFile -Encoding utf8
Write-Host "`nSubscriptions saved to $subFile"
Write-Host "Function webhook: $functionUrl/graphNotifications"
