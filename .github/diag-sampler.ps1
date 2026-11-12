# TEMPORARY (diag/win24 only): every 10 s, the machine's CPU, disk queue, free memory and the
# processes that used the most CPU since the last sample, to tell a machine-wide stall from one of
# Atticus's own.
param([string]$Out)
$prev = @{}
$end = (Get-Date).AddMinutes(25)
while ((Get-Date) -lt $end) {
  try {
    $c = Get-Counter -Counter @(
      '\Processor(_Total)\% Processor Time',
      '\PhysicalDisk(_Total)\Current Disk Queue Length',
      '\PhysicalDisk(_Total)\% Disk Time',
      '\PhysicalDisk(_Total)\Disk Transfers/sec',
      '\Memory\Available MBytes'
    ) -ErrorAction SilentlyContinue
    $v = $c.CounterSamples | ForEach-Object { "{0}={1:N0}" -f ($_.Path -replace '^.*\\\\[^\\]+\\', ''), $_.CookedValue }
    $now = @{}
    $top = Get-Process | ForEach-Object {
      $now[$_.Id] = $_.CPU
      $d = $_.CPU - ($prev[$_.Id] ?? 0)
      [pscustomobject]@{ N = "$($_.ProcessName)#$($_.Id)"; D = $d }
    } | Sort-Object D -Descending | Select-Object -First 6 | ForEach-Object { "{0}:{1:N1}s" -f $_.N, $_.D }
    $prev = $now
    Add-Content -Path $Out -Value ("[sample {0}] {1} | top: {2}" -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), ($v -join ' '), ($top -join ' '))
  } catch {
    Add-Content -Path $Out -Value "[sample error] $_"
  }
  Start-Sleep -Seconds 10
}
