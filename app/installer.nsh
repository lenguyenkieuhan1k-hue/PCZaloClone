; Custom NSIS installer script for ZaloMask
; This file is included by electron-builder's NSIS configuration

; MUI Settings
!include "MUI2.nsh"

; Version info (populated by electron-builder)
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "ZaloMask"
VIAddVersionKey "FileDescription" "ZaloMask - Multi-account & privacy toolkit cho Zalo"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "LegalCopyright" "Copyright 2026 ZaloMask"
VIAddVersionKey "OriginalFilename" "${EXE_INSTALLER_NAME}"

; Custom finish page options
!define MUI_FINISHPAGE_NOAUTOCLOSE

; Run after installation
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_CHECKED
!define MUI_FINISHPAGE_RUN_TEXT "Chạy ZaloMask ngay"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchLink"

Function LaunchLink
  ShellExecute "" "$INSTDIR\${APP_EXECUTABLE_NAME}"
FunctionEnd

; Show welcome + directory selector + confirm
!define MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Language
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Vietnamese"

; Custom strings for Vietnamese locale
LangString DESC_SECTION_INSTALL ${LANG_VIETNAMESE} "Cài đặt ZaloMask"
LangString DESC_SECTION_UNINSTALL ${LANG_VIETNAMESE} "Gỡ cài đặt ZaloMask"

; Optional: Add custom install section behavior
Section "Install"
  ; Default installation is handled by electron-builder
  ; Add any custom installation logic here if needed
SectionEnd

; Optional: Custom uninstall section
Section "Uninstall"
  ; Default uninstall is handled by electron-builder
  ; Add any custom cleanup logic here if needed
SectionEnd
