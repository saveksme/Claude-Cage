# Executed by the authenticated, fixed-VM PowerShell Direct maintenance session.
param([guid]$VMId,[string]$GUIUserSID,[string]$Stage,[string]$ArchiveSHA256,[bool]$Tools,[string]$PackagesJSON,[string]$CLIJSON)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if ([guid](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters').VirtualMachineId -ne $VMId -or
    $GUIUserSID -notmatch '^S-1-5-21-' -or $Stage -notlike (Join-Path $env:ProgramFiles 'Cage Component Update\*')) { throw 'Цель обновления компонентов не совпадает с идентификатором гостевой системы.' }
function Assert-LocalFile([string]$Path) {
    for ($entry=Get-Item -LiteralPath $Path -Force; $entry; $entry=if ($entry -is [IO.FileInfo]) {$entry.Directory} else {$entry.Parent}) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Каталог компонентов содержит файловую ссылку.' }
    }
}
Assert-LocalFile $Stage
$archive=Join-Path $Stage 'update.zip'
if ((Get-FileHash -LiteralPath $archive).Hash -ne $ArchiveSHA256) { throw 'Проверка пакета компонентов, переданного в гостевую систему, не пройдена.' }
& (Join-Path $env:SystemRoot 'System32/tar.exe') -xf $archive -C $Stage
if ($LASTEXITCODE) { throw 'Не удалось распаковать проверенный пакет компонентов.' }
$manifest=Get-Content -LiteralPath (Join-Path $Stage 'native-components.json') -Raw | ConvertFrom-Json
if ($manifest.protocol -ne 1 -or $manifest.system -cne 'windows-11' -or $manifest.revision -notmatch '^[a-f0-9]{64}$' -or @($manifest.files).Count -notin 1..10000) { throw 'Недопустимый список компонентов гостевой системы.' }
$roots=@{bridge=(Join-Path $env:ProgramFiles ('Cage Guest Bridge\'+$VMId));network=(Join-Path $env:ProgramFiles ('Cage Guest Network\'+$VMId))}
foreach ($root in $roots.Values) { Assert-LocalFile $root }
$targets=@{}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Stage 'files') -File -Recurse -Force) {
    Assert-LocalFile $file.FullName
    $relative=$file.FullName.Substring((Join-Path $Stage 'files').Length+1)
    $parts=$relative -split '\\',2
    if ($parts.Count -ne 2 -or !$roots.ContainsKey($parts[0]) -or $parts[1] -match '(^|\\)\.\.?(\\|$)|:') { throw 'Недопустимое расположение установки компонента.' }
    $targets[$relative.Replace('\','/')]=Join-Path $roots[$parts[0]] $parts[1]
}
foreach ($entry in $manifest.files) {
    if (!$entry.target) { continue }
    if (!$targets.ContainsKey($entry.target) -or (Get-FileHash -LiteralPath (Join-Path $Stage ('files/'+$entry.target))).Hash -ne $entry.installed_sha256) { throw 'Устанавливаемые компоненты не соответствуют списку.' }
}
$guiTask="Cage-GUI-Bridge-$VMId-$GUIUserSID"
$networkTask="Cage-Packet-Bridge-$VMId"
$tasks=@()
foreach ($spec in @(@($guiTask,'bridge','Cage.GuestClipboard.exe',"Cage protected GUI bridge $VMId $GUIUserSID"),@($networkTask,'network','Cage.GuestNetwork.exe',"Cage protected packet bridge $VMId $GUIUserSID"))) {
    $task=Get-ScheduledTask -TaskName $spec[0]
    if ($task.Description -cne $spec[3] -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $roots[$spec[1]] $spec[2])) { throw 'Фоновая задача гостевой системы не соответствует привязанному компоненту.' }
    $tasks+=@{Name=$spec[0];Active=($task.State -eq 'Running')}
}
$bootName='Cage-Workbench-Boot-'+$VMId.ToString('D')
$boot=Get-CimInstance Win32_Service -Filter "Name='$bootName'"
if ($boot -and ($boot.StartName -ne 'LocalSystem' -or $boot.PathName -cne ('"'+(Join-Path $roots.bridge 'cage-guest-boot.exe')+'" '+$VMId.ToString('D')))) { throw 'Служба загрузки гостевой системы не соответствует привязанному компоненту.' }
$backup=Join-Path $Stage 'backup'
$null=New-Item -ItemType Directory -Path $backup
$changed=[Collections.Generic.List[object]]::new()
$runtimes=[Collections.Generic.List[object]]::new()
$stopped=[Collections.Generic.List[string]]::new()
$bootStopped=$false
$committed=$false
function Set-ComponentAccess([string]$Path) {
    $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow')) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($GUIUserSID),'ReadAndExecute','Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Install-Component([string]$Source,[string]$Target) {
    $parent=[IO.Path]::GetDirectoryName($Target)
    $null=New-Item -ItemType Directory -Path $parent -Force
    Assert-LocalFile $parent
    $saved=Join-Path $backup ([string]$changed.Count)
    $exists=Test-Path -LiteralPath $Target
    if ($exists) { Assert-LocalFile $Target; Copy-Item -LiteralPath $Target -Destination $saved; Set-Acl -LiteralPath $saved -AclObject (Get-Acl -LiteralPath $Target) }
    $changed.Add(@{Target=$Target;Saved=$saved;Existed=$exists})
    $next=$Target+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        Copy-Item -LiteralPath $Source -Destination $next
        Set-ComponentAccess $next
        if ($exists) { [IO.File]::Replace($next,$Target,[Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($next,$Target) }
    } finally { if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next } }
}
try {
    foreach ($task in $tasks) {
        if (!$task.Active) { continue }
        Stop-ScheduledTask -TaskName $task.Name
        $stopped.Add($task.Name)
        $deadline=[DateTime]::UtcNow.AddSeconds(15)
        while ((Get-ScheduledTask -TaskName $task.Name).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if ((Get-ScheduledTask -TaskName $task.Name).State -eq 'Running') { throw 'Фоновый компонент ещё завершается; исходные файлы сохранены, повторите позже.' }
    }
    if ($boot -and $boot.State -eq 'Running') { Stop-Service -Name $bootName; $bootStopped=$true }
    foreach ($relative in $targets.Keys) { Install-Component (Join-Path $Stage ('files/'+$relative)) $targets[$relative] }
    if ($Tools) {
        $toolStage=Join-Path $roots.bridge 'setup-packages'
        $null=New-Item -ItemType Directory -Path $toolStage -Force
        Assert-LocalFile $toolStage
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Stage 'tools') -File) { Copy-Item -LiteralPath $file.FullName -Destination $toolStage -Force }
        # Keep long editor paths inside their directory throughout publication.
        # Stage under the protected bridge so the paired user inherits read access.
        $runtime=Join-Path $roots.bridge ('.runtime-'+[guid]::NewGuid().ToString('N'))
        $null=New-Item -ItemType Directory -Path $runtime
        & (Join-Path $env:SystemRoot 'System32/tar.exe') -xf (Join-Path $toolStage 'extras.zip') -C $runtime
        if ($LASTEXITCODE) { throw 'Не удалось распаковать инструменты среды.' }
        foreach ($name in @('node.exe','playwright','vscode-cli','vscode-server','editor-runtime.json')) {
            $source=Join-Path $runtime $name
            Assert-LocalFile $source
            $destination=Join-Path $roots.bridge $name
            $saved=Join-Path $backup $name
            $exists=Test-Path -LiteralPath $destination
            if ($exists) { Assert-LocalFile $destination; Move-Item -LiteralPath $destination -Destination $saved }
            $runtimes.Add(@{Target=$destination;Saved=$saved;Existed=$exists;Name=$name})
            Move-Item -LiteralPath $source -Destination $destination
        }
        $installer=Join-Path $Stage 'install-windows-workbench-components.ps1'
        $options=@($VMId,$GUIUserSID,$roots.bridge,$toolStage,$PackagesJSON,$CLIJSON,(Get-FileHash -LiteralPath (Join-Path $toolStage 'extras.zip')).Hash)
        & $installer @options 'Prepare' -RuntimeInstalled
        & $installer @options 'UserTools'
        # UserTools may start the GUI task. All updated binaries are already installed.
    }
    foreach ($entry in $manifest.files) {
        if ($entry.target -and (Get-FileHash -LiteralPath $targets[$entry.target]).Hash -ne $entry.installed_sha256) { throw 'Проверка компонентов после установки не пройдена.' }
    }
    & (Join-Path $roots.bridge 'Cage.GuestClipboard.exe') self-test | Out-Null
    if ($LASTEXITCODE) { throw 'Новый компонент подключения гостевой системы не прошёл самопроверку.' }
    Install-Component (Join-Path $Stage 'native-components.json') (Join-Path $roots.bridge 'native-components.json')
    foreach ($name in $stopped) { Start-ScheduledTask -TaskName $name }
    if ($bootStopped) { Start-Service -Name $bootName }
    $committed=$true
} finally {
    if (!$committed) {
        foreach ($name in $stopped) { Stop-ScheduledTask -TaskName $name -ErrorAction Continue }
        if ($bootStopped) { Stop-Service -Name $bootName -ErrorAction Continue }
        for ($index=$runtimes.Count-1; $index -ge 0; $index--) {
            $item=$runtimes[$index]
            if (Test-Path -LiteralPath $item.Target) { Move-Item -LiteralPath $item.Target -Destination (Join-Path $Stage ('failed-'+$item.Name)) }
            if ($item.Existed) { Move-Item -LiteralPath $item.Saved -Destination $item.Target }
        }
        for ($index=$changed.Count-1; $index -ge 0; $index--) {
            $item=$changed[$index]
            if ($item.Existed) { Copy-Item -LiteralPath $item.Saved -Destination $item.Target -Force; Set-Acl -LiteralPath $item.Target -AclObject (Get-Acl -LiteralPath $item.Saved) }
            elseif (Test-Path -LiteralPath $item.Target) { Remove-Item -LiteralPath $item.Target }
        }
        foreach ($name in $stopped) { Start-ScheduledTask -TaskName $name -ErrorAction Continue }
        if ($bootStopped) { Start-Service -Name $bootName -ErrorAction Continue }
    }
    if ($runtime -and (Test-Path -LiteralPath $runtime)) { Move-Item -LiteralPath $runtime -Destination (Join-Path $Stage 'runtime-staging') }
}
Write-Output 'Компоненты гостевой системы синхронизированы; исходные ключи сопряжения и пользовательские каталоги сохранены.'
