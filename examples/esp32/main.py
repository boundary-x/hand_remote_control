# ESP32 MicroPython: receive the app's original newline-delimited packets.
# Save this file as main.py alongside ble_library.py on the ESP32.
import bluetooth
import time
from ble_library import BLESimplePeripheral

buffer = ""

def receive(text):
    global buffer
    # ble_library passes a decoded string. A packet can span multiple BLE writes.
    buffer += text
    while "\n" in buffer:
        line, buffer = buffer.split("\n", 1)
        print("Received:", line.rstrip("\r"))
        # Add your board-specific output or motor code here.
    if len(buffer) > 1024:
        buffer = ""
        print("Incomplete packet discarded")

device = BLESimplePeripheral(bluetooth.BLE(), name=b"ESP32")
device.on_write(receive)
print("Connect to ESP32 from the web app.")
connected = False
while True:
    if device.is_connected() != connected:
        connected = device.is_connected()
        buffer = ""
        print("Connected" if connected else "Disconnected")
    time.sleep_ms(100)
