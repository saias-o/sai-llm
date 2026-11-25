; SAIAS installer (Inno Setup 6). Build it with scripts\Build-Installer.ps1.
; Per-user install, no administrator rights. After the files are copied, Install-SAIAS.cmd runs
; in a console to pick and download the models for this PC.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppBuild
  #define AppBuild "..\build"
#endif

[Setup]
AppId={{6F0C2B8E-4E1F-4B7A-9C55-5A1A5D3C9E21}
AppName=SAIAS
AppVersion={#AppVersion}
AppVerName=SAIAS {#AppVersion}
AppPublisher=SAIAS
AppPublisherURL=https://github.com/saias-o/saias-llm
AppSupportURL=https://github.com/saias-o/saias-llm/issues
DefaultDirName={localappdata}\Programs\SAIAS
DefaultGroupName=SAIAS
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=SAIAS-Setup-{#AppVersion}
SetupIconFile=..\SAIAS-LLM\saias-llm.ico
UninstallDisplayIcon={app}\SAIAS.exe
LicenseFile=..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"
Name: "autostart"; Description: "Start SAIAS with Windows (in the notification area)"

[Files]
Source: "{#AppBuild}\SAIAS.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppBuild}\pdfium.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppBuild}\PDFium-licenses\*"; DestDir: "{app}\PDFium-licenses"; Flags: ignoreversion recursesubdirs
Source: "..\saias.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Install-SAIAS.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Start-SAIAS.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "..\catalog\*"; DestDir: "{app}\catalog"; Flags: ignoreversion recursesubdirs
Source: "..\mcp\*"; DestDir: "{app}\mcp"; Flags: ignoreversion recursesubdirs
Source: "..\templates\*"; DestDir: "{app}\templates"; Flags: ignoreversion recursesubdirs
Source: "..\scripts\Get-Node.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion

[Icons]
Name: "{group}\SAIAS"; Filename: "{app}\SAIAS.exe"
Name: "{group}\Llama Chat"; Filename: "{app}\Start-SAIAS.cmd"; IconFilename: "{app}\SAIAS.exe"
Name: "{group}\Install or change models"; Filename: "{app}\Install-SAIAS.cmd"; IconFilename: "{app}\SAIAS.exe"
Name: "{autodesktop}\SAIAS"; Filename: "{app}\SAIAS.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SAIAS"; \
    ValueData: """{app}\SAIAS.exe"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Model setup in a console: hardware detection, profile choice, licenses and downloads.
Filename: "{cmd}"; Parameters: "/d /c """"{app}\Install-SAIAS.cmd"" --no-shortcut"""; WorkingDir: "{app}"; \
    StatusMsg: "Setting up the SAIAS models..."; Flags: waituntilterminated
Filename: "{app}\SAIAS.exe"; Description: "Open SAIAS"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/d /c ""{app}\saias.cmd"" stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopSAIAS"

[Code]
// Models are large: ask before deleting them with the app.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\SAIAS');
    if DirExists(DataDir) and (MsgBox('Also delete the downloaded models, conversations and settings in ' + DataDir + '?',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(DataDir, True, True, True);
  end;
end;
