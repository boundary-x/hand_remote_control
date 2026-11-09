# ESP32 support

Optional micro:bit / ESP32 selector. Default: micro:bit; no persisted board selection. Existing micro:bit UI and wire payloads are preserved.

ESP32 uses service 6e400001-b5a3-f393-e0a9-e50e24dcca9e, browser write 6e400002, browser notifications 6e400003 (same UUID suffix). Device name starts with ESP or MPY. Writes select supported response properties and send chunks of at most 20 bytes. Receiver must reassemble lines; see examples/esp32. No motor mapping is assumed.

## Update — 2026-11-09
Added ESP32 connection, board selection feedback, contextual examples and test firmware. Original micro:bit support content is retained. Hardware verification is confirmed only for the keypad baseline; per-app hardware validation remains required.
