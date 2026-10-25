; Custom NSIS code, included by electron-builder (`nsis.include` in electron-builder.yml).
;
; A real uninstall also removes electron-updater's cache in %LOCALAPPDATA%: the installer copy
; kept for differential updates (installer.exe, ~120 MB) and any downloaded update (pending\).
; `deleteAppDataOnUninstall` only covers %APPDATA%. Skipped during an update: the new installer
; runs the old uninstaller with --updated, and the cache then holds the update being installed.
;
; The folder is electron-updater's `updaterCacheDirName`: the package name (@concord/desktop)
; without the slash, lowercased, plus "-updater" (housekeeping.test.ts keeps the two in sync).
!define CONCORD_UPDATER_CACHE_DIR "@concorddesktop-updater"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\${CONCORD_UPDATER_CACHE_DIR}"
  ${endIf}
!macroend
