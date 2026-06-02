Set-Location 'c:\Users\AkramHKIRI\Desktop\outlook-support-kanban'
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'C:\Program Files\nodejs\node.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'c:\Users\AkramHKIRI\Desktop\outlook-support-kanban' -WindowStyle Hidden
