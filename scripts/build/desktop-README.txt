BMWeb for Windows and Linux
===========================

BMW diagnostics: read fault codes, watch live values, run actuator tests,
browse BMW's own wiring diagrams, and read a module's coding.

This is the same program as the BMacW macOS app and the BMWeb website -- the
same decoder, the same screens, the same data. Only the window around it
differs.


RUNNING IT
----------

Windows   double-click BMWeb\BMWeb.exe
Linux     ./BMWeb/BMWeb      (chmod +x BMWeb if your unzip dropped the bit)

No installer and no runtime to fetch first: everything is in the folder. Move
the whole folder wherever you like, but keep it together -- the app reads
data/ beside the executable.


WHAT EACH PLATFORM NEEDS
------------------------

Windows
  The WebView2 runtime, which draws the interface. Windows 11 and current
  Windows 10 already have it. If the window opens blank, install it from
  Microsoft (search "WebView2 Runtime evergreen installer") and restart.

  SmartScreen will warn about an unsigned app on first run: "More info" ->
  "Run anyway". The build is unsigned because a code-signing certificate is
  a paid yearly subscription.

Linux
  WebKitGTK, which draws the interface:
    Debian/Ubuntu   sudo apt install libwebkit2gtk-4.1-0
    Fedora          sudo dnf install webkit2gtk4.1
    Arch            sudo pacman -S webkit2gtk-4.1

  And permission to open the diagnostic cable. Either install the shipped
  udev rule:
    sudo cp 99-bmacw-kdcan.rules /etc/udev/rules.d/
    sudo udevadm control --reload-rules && sudo udevadm trigger
  or add yourself to the dialout group:
    sudo usermod -aG dialout $USER        (then log out and back in)

  Without one of those the cable appears but will not open, and the app says
  so when you try.


CONNECTING TO A CAR
-------------------

K+DCAN cable (USB)
  Plug it into the car's OBD port and the computer, ignition on with the
  engine off, then pick the port in the app. It shows up as COM3 or similar
  on Windows, /dev/ttyUSB0 on Linux.

THOR WiFi adapter
  Plug it into the OBD port, join its "Thor_Wifi" network, then choose THOR
  in Settings. The app can join the network for you where the system allows
  it (netsh on Windows, nmcli on Linux); otherwise join it from your usual
  network menu first.

No cable at all
  Everything that does not need a car still works: fault-code lookup, wiring
  diagrams, and every screen in demo mode (Settings -> Demo data).


DIFFERENCES FROM THE MAC BUILD
------------------------------

Three things are macOS-only, and the app simply does not show them here
rather than offering buttons that fail:

  PDF fault reports   macOS renders these with a system API that has no
                      equivalent here. Print from the wiring view still
                      works, and fault lists still export as text.
  Translucent theme   The Aero skin is opaque instead of frosted.
  Dock icon theming   There is no dock to theme.

Everything that talks to the car is identical: it is literally the same code.


WHERE YOUR SETTINGS LIVE
------------------------

  Windows   %APPDATA%\BMacW\settings.json
  Linux     ~/.config/BMacW/settings.json

Delete that file to start fresh. (The folder is named BMacW on every platform
-- it is the app's identity on disk, not a label, so any build reads any
other's settings.)
