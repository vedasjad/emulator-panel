# Emulator Panel

Run Android emulators inside VS Code, the way Android Studio's Running Devices panel does, without losing the emulator's own extended controls: Location with route playback, Cellular, Battery, Sensors, Snapshots and the rest. Mirror Android phones in the same place, and manage iOS simulators from the same Device Manager.

> **Preview, macOS only.** Emulator Panel is developed and tested on macOS. Windows and Linux are not supported yet.

## Features

- **Device Manager** in the activity bar, with Android and iOS sections. Every AVD shows its Android version, ABI and API level, and can be sorted by name, API or type. Run, stop, cold boot, wipe data, delete (to the Trash), reveal its files or edit `config.ini`. Emulators started elsewhere are detected through adb.
- **Running Devices** editor tab: one or more emulator screens with touch, scroll and keyboard input. Devices sit side by side when there is room, otherwise one at a time with a switcher. A toolbar above each screen has Back, Home, Overview, volume, power, rotation, screenshot, Location and Extended Controls, and drops the less important buttons when the column is narrow.
- **Native extended controls**: emulators run with their window hidden rather than headless, so Location, Extended Controls and the other panes open as the emulator's real windows, with route playback and saved points.
- **Phone mirroring**: Android phones connected over USB or Wi-Fi appear in the Device Manager and can be shown in Running Devices with touch, scroll and keyboard input, through the bundled scrcpy server. Screenshot, open a URL, toggle dark mode, copy the serial or reboot from the same menu.
- **Separate window**: move Running Devices into its own compact window, keep it on top, and move it back beside your editor. Once moved, it keeps opening in its own window, at the position and size you last left it, until you move it back. The window stays open when its last device stops, with a button to start another; closing the window with devices in it stops them and leaves the window open and empty, and closing the empty window closes it.
- **Tidy editor layout**: the Running Devices column fits its devices and keeps that width when the sidebar opens or closes or the window is resized; drag the border to change it. Files never open in the Running Devices group, and when it is the only group left a new file opens to its left.
- **iOS simulators**: run (opens Simulator.app), stop, erase and delete; set a location, play a GPX or KML route at a chosen speed or one of Apple's built-in scenarios; toggle dark mode, open a URL or deep link, take a screenshot and copy the UDID. Points saved in Android Studio are offered for both platforms. Paired iPhones are listed with their connection state.
- **Screenshots** of any device, saved to a folder and copied to the clipboard.
- **Install apps**: drag an APK from the Explorer or Finder onto Running Devices, right-click it in the Explorer and choose **Install APK on Device**, or run that command to pick one. Other files dragged from Finder onto a device are copied to its Downloads folder.
- **Clipboard and keyboard**: copy and paste between your Mac and the device, and right-click the screen for Back.

## Requirements

- macOS.
- VS Code 1.90 or newer.
- The Android SDK with the **Android Emulator** and **Android SDK Platform-Tools** packages, and at least one AVD. Installing Android Studio sets this up. Tested with Android Emulator 36.6.
- For iOS simulators: Xcode with at least one iOS simulator runtime.
- For phone mirroring: USB debugging enabled on the phone, and Android 5.0 or newer.

## Getting started

Install **Emulator Panel** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=vedasjad.emulator-panel), or run `code --install-extension vedasjad.emulator-panel`. In Cursor, Windsurf, VSCodium and other editors that use [Open VSX](https://open-vsx.org/extension/vedasjad/emulator-panel), search for Emulator Panel in the Extensions view.

1. Open the **Emulators** view in the activity bar.
2. Press ▶ next to an AVD. It starts with its window hidden and opens in the Running Devices tab.
3. Use `+` in Running Devices to add another emulator or a connected phone.

If the Device Manager says the Android SDK was not found, set `emulatorPanel.sdkPath` to your SDK folder, for example `~/Library/Android/sdk`.

Closing a device with the × beside its name, or closing the whole Running Devices tab, stops those emulators. The show/hide button in the Device Manager title hides Running Devices while the emulators keep running.

## Keyboard shortcuts

Active while Running Devices is focused. Change them in **Preferences: Open Keyboard Shortcuts** by searching for "Emulator:".

| Action | Shortcut |
|---|---|
| Location | `Cmd+Shift+L` |
| Cellular | `Cmd+Shift+C` |
| Battery | `Cmd+Shift+B` |
| Virtual sensors | `Cmd+Shift+V` |
| Fingerprint | `Cmd+Shift+F` |
| Camera | `Cmd+Shift+A` |
| Screen record | `Cmd+Shift+R` |
| Snapshots | `Cmd+Shift+N` |
| Emulator settings | `Cmd+Shift+S` |
| Back | `Cmd+Backspace` |
| Home | `Cmd+Shift+H` |
| Overview | `Cmd+O` |
| Rotate left / right | `Cmd+Left` / `Cmd+Right` |
| Volume up / down | `Cmd+=` / `Cmd+-` |
| Power | `Cmd+P` |
| Screenshot | `Cmd+S` |

Phone has no shortcut so that `Cmd+Shift+P` keeps opening the Command Palette; use **Emulator: Phone** instead.

`Cmd+A`, `Cmd+C`, `Cmd+X` and `Cmd+V` select all, copy, cut and paste in the focused device, through the Mac clipboard. They work in Flutter text fields too, and can't be rebound. Right-clicking the screen presses Back.

## Settings

| Setting | Default | Description |
|---|---|---|
| `emulatorPanel.sdkPath` | `""` | Android SDK folder. Falls back to `ANDROID_HOME`, `ANDROID_SDK_ROOT` and `~/Library/Android/sdk`. User settings only. |
| `emulatorPanel.emulatorArgs` | `[]` | Extra arguments for every emulator launch, for example `["-no-snapshot-load"]`. User settings only. |
| `emulatorPanel.stopOnClose` | `true` | Stop emulators when they are closed in Running Devices. |
| `emulatorPanel.openIn` | `beside` | Open Running Devices beside the current editor, or as a tab in it. |
| `emulatorPanel.fitColumnOnOpen` | `true` | Resize the Running Devices column to fit its devices. |
| `emulatorPanel.keepColumnWidth` | `true` | Keep the column width when the sidebar or window size changes. |
| `emulatorPanel.showToolbar` | `true` | Show the toolbar above each screen. |
| `emulatorPanel.compactWindow` | `true` | Use a compact window when Running Devices opens in a separate window. |
| `emulatorPanel.showIosDevices` | `true` | List iOS simulators and paired iPhones. |
| `emulatorPanel.showPhysicalDevices` | `true` | List Android phones and paired iPhones. |
| `emulatorPanel.mirroring.maxSize` | `1920` | Longest side of a mirrored phone screen, in pixels. `0` uses the full resolution. |
| `emulatorPanel.mirroring.maxFps` | `60` | Maximum frame rate of a mirrored phone screen. |
| `emulatorPanel.mirroring.bitRate` | `8` | Mirroring bit rate in Mbit/s. Lower it on slow Wi-Fi. |
| `emulatorPanel.mirroring.stayAwake` | `true` | Keep a mirrored phone awake while it is plugged in; its own setting comes back when mirroring stops. |
| `emulatorPanel.screenshotFolder` | `""` | Screenshot folder. Defaults to the Desktop; relative paths use the workspace folder. |

## Privacy

Emulator Panel collects no telemetry and makes no network requests. It talks only to programs on your Mac: the emulator's local gRPC port, `adb`, and Apple's `xcrun simctl` and `devicectl`.

## How it works

AVDs are launched as `emulator -avd <name> -qt-hide-window -grpc <port> -grpc-use-token`. The emulator writes its gRPC port and token to its discovery file, and the extension uses the emulator's gRPC API, with the proto files shipped in `<sdk>/emulator/lib`, to stream the screen into a webview, send touch, wheel and key events, rotate the device, take screenshots and open extended control panes. The emulator log for each launch is written to `$TMPDIR/emulator-panel/<avd>.log`, and decisions are logged to the **Emulator Panel** output channel (**Emulator: Show Log**).

Android phones are mirrored with the bundled scrcpy server: it is pushed over adb, reached through `adb forward`, streams H.264 that the webview decodes with WebCodecs, and receives touch, scroll, key and text events over its control socket.

iOS simulators are managed with `xcrun simctl`, and paired iPhones are listed with `xcrun devicectl`.

## Known limitations

- Emulators started without gRPC, for example from another tool's device picker, appear as "running outside Emulator Panel" and can only be stopped.
- Emulators started headless with `-no-window` can be shown but have no extended controls.
- iOS simulator screens are not embedded in Running Devices; they stay in Simulator.app, because Apple has no public API for streaming a simulator's screen or injecting touches.
- Physical iPhones cannot be mirrored or controlled.
- Column fitting only applies when editor groups are side by side.
- The separate window is opened at its saved position through an internal VS Code command. If a VS Code update changes it, Running Devices opens in the main window instead and the reason is logged.

## Building from source

```bash
npm install
npm run typecheck
npm run build
npx vsce package --no-dependencies --target darwin-arm64
code --install-extension emulator-panel-darwin-arm64-0.1.0.vsix --force
```

Then run **Developer: Reload Window**. Use `--target darwin-x64` for Intel Macs.

## License

MIT. The bundled scrcpy server (`media/vendor/scrcpy-server-v4.1`) is the unmodified release from [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy), licensed under the Apache License 2.0; see `ThirdPartyNotices.txt`.
