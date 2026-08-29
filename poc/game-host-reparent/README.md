# Game host reparent PoC

This experiment is the phase-0 gate described by the game-window requirement and design documents. It uses the repository's locked Electron version, the production game preload, and the production host/webview security preferences.

Run on Windows after `npm install` and `npm run build`:

```powershell
npm run poc:game-window
```

The script performs 100 detach/attach round trips (200 native view reparent operations), keeps a 50 ms simulated `/kcsapi` stream running, probes WebAudio, keyboard, pointer, wheel and host-overlay hit testing, tests close-to-attach and two rollback paths, then writes `result.json`.

The automated result only covers the Windows/display configuration recorded in that file. The 100%, 125%, 150%, 200% and mixed-DPI matrix still needs separate runs on matching hardware before release.
