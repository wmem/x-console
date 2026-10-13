param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $Config | ConvertFrom-Json
$serial = $settings.serial
$port = [System.IO.Ports.SerialPort]::new($serial.port, [int]$serial.baud_rate,
    [System.IO.Ports.Parity]::None, [int]$serial.data_bits, [System.IO.Ports.StopBits]::One)
$port.Handshake = [System.IO.Ports.Handshake]::None
$port.Encoding = [System.Text.UTF8Encoding]::new($false)
if ($null -ne $serial.board_control.dtr) { $port.DtrEnable = [bool]$serial.board_control.dtr }
if ($null -ne $serial.board_control.rts) { $port.RtsEnable = [bool]$serial.board_control.rts }
$port.ReadTimeout = [int]$settings.poll_ms
$port.WriteTimeout = [int]$settings.write_timeout_ms
try {
    $port.Open()
    $port.DiscardInBuffer()
    [Console]::WriteLine('{"ready":true}')
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $cmd = $line | ConvertFrom-Json
            if ($null -ne $cmd.text) { $port.Write([string]$cmd.text) }
            $waitMs = [int]$cmd.waitMs
            if ($waitMs -lt 0 -or $waitMs -gt 10000) { throw 'Invalid waitMs' }
            $rx = [System.Text.StringBuilder]::new()
            $timer = [System.Diagnostics.Stopwatch]::StartNew()
            do {
                [void]$rx.Append($port.ReadExisting())
                if ($port.Encoding.GetByteCount($rx.ToString()) -gt $settings.max_receive_bytes) { throw 'Serial response too long' }
                if ($timer.ElapsedMilliseconds -ge $waitMs) { break }
                Start-Sleep -Milliseconds 10
            } while ($true)
            [Console]::WriteLine((@{ok=$true;text=$rx.ToString()} | ConvertTo-Json -Compress))
        } catch {
            [Console]::WriteLine((@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
        }
    }
} catch {
    [Console]::WriteLine((@{ready=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
    exit 1
} finally {
    if ($port.IsOpen) { $port.Close() }
    $port.Dispose()
}
