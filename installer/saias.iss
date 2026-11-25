; SAIAS installer (Inno Setup 6). Build it with scripts\Build-Installer.ps1.
; Per-user install, no administrator rights. After the files are copied, Install-SAIAS.cmd opens
; the graphical setup (src\setup.js) to pick and download the models for this PC.

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
Source: "..\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs
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
; Model setup in its own window: the advisor preselects the models this PC can run, then the
; licenses, downloads and tools. Its console only shows a log, so it starts minimized.
Filename: "{cmd}"; Parameters: "/d /c """"{app}\Install-SAIAS.cmd"" --no-shortcut"""; WorkingDir: "{app}"; \
    StatusMsg: "Choosing and downloading the SAIAS models in the setup window..."; Flags: waituntilterminated runminimized
Filename: "{app}\SAIAS.exe"; Description: "Open SAIAS"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/d /c ""{app}\saias.cmd"" stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopSAIAS"

[Code]
// "saias install" may have added the app folder to the user PATH: take it out again.
procedure RemoveFromUserPath(Dir: String);
var
  Path, Entry, Kept: String;
  Separator: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then
    exit;
  Kept := '';
  while Path <> '' do
  begin
    Separator := Pos(';', Path);
    if Separator = 0 then
    begin
      Entry := Path;
      Path := '';
    end else begin
      Entry := Copy(Path, 1, Separator - 1);
      Delete(Path, 1, Separator);
    end;
    if (Entry <> '') and (CompareText(RemoveBackslashUnlessRoot(Entry), RemoveBackslashUnlessRoot(Dir)) <> 0) then
    begin
      if Kept <> '' then
        Kept := Kept + ';';
      Kept := Kept + Entry;
    end;
  end;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Kept);
end;

// Models are large: ask before deleting them with the app. The setup window may have put them
// on another drive; data-folder.txt in the standard folder then names that folder.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, OtherDir: AnsiString;
  Question: String;
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath(ExpandConstant('{app}'));
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\SAIAS');
    OtherDir := '';
    if LoadStringFromFile(DataDir + '\data-folder.txt', OtherDir) then
      OtherDir := Trim(OtherDir);
    if (OtherDir <> '') and not DirExists(OtherDir) then
      OtherDir := '';
    if not DirExists(DataDir) and (OtherDir = '') then
      exit;
    Question := 'Also delete the downloaded models, conversations and settings in ' + DataDir;
    if OtherDir <> '' then
      Question := Question + ' and ' + OtherDir;
    if MsgBox(Question + '?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      if OtherDir <> '' then
        DelTree(OtherDir, True, True, True);
      DelTree(DataDir, True, True, True);
    end;
  end;
end;
