# README GIF: budget stop -> resume in the same task.
# Run from the mini-DSH repository root after `pnpm build`:
#   vhs scripts/demo-resume.tape

Output docs/images/demo-resume.gif

Set Shell "powershell"
Set FontFamily "Cascadia Mono"
Set FontSize 16
Set Width 1400
Set Height 720
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

# UTF-8 output for Chinese text, a short prompt, and no leftover session id.
Hide
Type "[Console]::OutputEncoding = [Text.Encoding]::UTF8; function prompt { '> ' }; Remove-Item Env:MINI_DSH_SESSION_ID -ErrorAction SilentlyContinue; Clear-Host"
Enter
Sleep 1s
Show

Type "node dist/scripts/demo-resume.js"
Sleep 600ms
Enter

# The demo finishes in about a second; hold the final checklist on screen.
Sleep 9s
