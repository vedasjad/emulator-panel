# Emulator Panel

Run Android emulators inside VS Code, the way Android Studio's Running Devices panel does, without losing the emulator's own extended controls (Location with route playback, Cellular, Battery, Sensors, Snapshots and so on). iOS simulators are managed from the same Device Manager.

## Features

- **Device Manager** in the activity bar: every AVD with its Android version, ABI and API level, sortable by name, API or type. Run, stop, cold boot, wipe data, delete (to the Trash), reveal files or edit `config.ini`. Emulators started outside the extension are detected through adb.
- **Running Devices** editor tab: one or more emulator screens with touch, scroll and keyboard input. Devices sit side by side when the tab is wide enough, otherwise one at a time with a switcher. The editor column resizes to fit the devices.
- **Native extended controls**: the emulator runs with its window hidden, so the Location, Extended Controls and other panes open as the emulator's real windows.
- **Separate window**: move Running Devices into its own compact window, keep it on top, and move it back beside your editor. Once moved, it keeps opening in its own window, directly at the position and size you last left it, until you move it back. Each device in the window has its own × to stop it. The window stays open when its last device stops, with a button to start another. Closing the window with devices in it stops them and leaves the window open and empty; closing the empty window closes it.
- **Editor groups**: files never open in the Running Devices group. When it is the only group left, a new file opens to its left.
- **iOS simulators** in the same Device Manager: run (opens Simulator.app), stop, erase, delete, set a location, play a GPX or KML route (or one of Apple's built-in scenarios) at a chosen speed, toggle dark mode, open a URL or deep link, take a screenshot, copy the UDID. Saved points from Android Studio are offered for both platforms.
- **Physical devices** appear in their platform's section: Android phones over USB or Wi-Fi via adb (mirror in Running Devices with touch, scroll and keyboard, screenshot, open URL, dark mode, copy serial, reboot) and paired iPhones via `devicectl` (connection state, copy UDID).
- **Screenshots** saved to a folder and copied to the clipboard on macOS.

## Requirements

- Android SDK with the `emulator` and `platform-tools` packages, and at least one AVD.
- VS Code 1.90 or newer.
- For iOS simulators: macOS with Xcode and at least one iOS simulator runtime.
- Developed and tested on macOS with emulator 36.6.

## Install from source

```bash
npm install
npm run build
npx vsce package --no-dependencies --skip-license
code --install-extension emulator-panel-0.0.1.vsix --force
```

Then run **Developer: Reload Window**.

## Usage

Open the **Emulators** view in the activity bar and press ▶ on an AVD. It starts with its window hidden and opens in the Running Devices tab. The toolbar above each screen has Back, Home, Overview, volume, power, rotation, screenshot, Location and Extended Controls. `+` adds another device.

Closing a device (`×` beside its name) or the whole Running Devices tab stops those emulators. The show/hide button in the Device Manager title hides the tab while the emulators keep running.

### Shortcuts

Active while the Running Devices tab is focused. On Windows and Linux use `Ctrl` instead of `Cmd`.

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

## Settings

| Setting | Default | Description |
|---|---|---|
| `emulatorPanel.sdkPath` | `""` | Android SDK root. Falls back to `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the default SDK locations. |
| `emulatorPanel.emulatorArgs` | `[]` | Extra arguments for every launch, for example `["-no-snapshot-load"]`. |
| `emulatorPanel.showToolbar` | `true` | Show the toolbar above each screen. |
| `emulatorPanel.fitColumnOnOpen` | `true` | Resize the Running Devices column to fit its devices. |
| `emulatorPanel.stopOnClose` | `true` | Stop emulators when they are closed in Running Devices. |
| `emulatorPanel.compactWindow` | `true` | Use a compact window when Running Devices moves to a new window. |
| `emulatorPanel.openIn` | `beside` | Editor column Running Devices opens in. |
| `emulatorPanel.screenshotFolder` | `""` | Screenshot folder. Defaults to the Desktop. |

## How it works

AVDs are launched as `emulator -avd <name> -qt-hide-window -grpc <port> -grpc-use-token -crash-report-mode never`. The emulator writes its gRPC port and token to its discovery file (`~/Library/Caches/TemporaryItems/avd/running/pid_*.ini` on macOS). The extension uses the emulator's gRPC API, with the proto files shipped in `<sdk>/emulator/lib`, to stream PNG frames into a webview, send touch, wheel and key events, rotate the device, take screenshots and open extended control panes. The emulator log for each launch is written to `$TMPDIR/emulator-panel/<avd>.log`, and layout decisions are logged to the **Emulator Panel** output channel.

Physical Android phones are mirrored with the bundled scrcpy server: it is pushed over adb, reached through `adb forward`, streams H.264 that the webview decodes with WebCodecs, and receives touch, scroll, key and text events over its control socket.

iOS simulators are managed with `xcrun simctl`: `list -j` for the Device Manager, `boot`/`shutdown`/`erase`/`delete`, `location set|start|run|clear` for points and routes, `ui appearance`, `openurl` and `io screenshot`.

## Limitations

- Emulators started without gRPC (for example from Dart's device picker) appear as "running outside Emulator Panel" and can only be stopped.
- Emulators started headless with `-no-window` can be shown but have no extended controls.
- If Running Devices is moved to another window with VS Code's own tab menu instead of the extension's button, the window buttons do not know it moved.
- Column fitting only applies when editor groups are side by side.
- The separate window is opened at its saved position through VS Code's internal `_workbench.openWith` command. If a VS Code update changes that command, Running Devices opens in the main window instead and the reason is logged.
- iOS simulator screens are not embedded in Running Devices yet; they stay in Simulator.app. Apple has no public API for streaming a simulator's screen or injecting touches.
- Physical iPhones cannot be mirrored or controlled.

## Third-party software

`media/vendor/scrcpy-server-v4.1` is the unmodified scrcpy server from [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) (release v4.1, SHA-256 `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`), licensed under the Apache License 2.0.
