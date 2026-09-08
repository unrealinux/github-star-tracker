$ErrorActionPreference = 'Stop'
$nssm = 'E:\Project\github-star-tracker\nssm\nssm.exe'
$node = 'C:\Program Files\nodejs\node.exe'
$app = 'E:\Project\github-star-tracker\server.js'
$dir = 'E:\Project\github-star-tracker'

Write-Host '>> install service'
& $nssm install GitHubStarTracker $node $app

Write-Host '>> set AppDirectory'
& $nssm set GitHubStarTracker AppDirectory $dir

Write-Host '>> set log stdout/stderr'
& $nssm set GitHubStarTracker AppStdout "$dir\logs\stdout.log"
& $nssm set GitHubStarTracker AppStderr "$dir\logs\stderr.log"
& $nssm set GitHubStarTracker AppRotateFiles 1
& $nssm set GitHubStarTracker AppRotateBytes 1048576

Write-Host '>> set auto start'
& $nssm set GitHubStarTracker Start SERVICE_AUTO_START

Write-Host '>> start service'
& $nssm start GitHubStarTracker

Write-Host '>> done'
