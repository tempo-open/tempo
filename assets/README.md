# Brand icons

Each channel folder (`dev`, `nightly` and `prod`) holds the macOS, iOS, universal, web and Windows icon files, plus an Icon Composer project whose one image layer is `app-icon.icon/Assets/tempo.png`. The nightly and development icons are the production icon with its hue turned, so each channel has its own color in the Dock. The production Mac build uses `prod/black-macos.icns` as is, so sizes drawn by hand reach the app; other channels scale their 1024 down.

The macOS PNGs have the classic macOS safe area: the opaque body is 824×824, inset 100 pixels on every side, with only the icon's shadow in the transparent canvas around it.

`vp run icons:export` and `vp run icons:check` render from the Icon Composer projects on a Mac with Icon Composer 2 or newer. They leave the macOS PNGs alone.
