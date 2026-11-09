# BioBridge firmware

ESP32 firmware for the two reference nodes. Both nodes speak the [BioBridge frame protocol](../protocol/FRAME.md) and show up in the web app under **Devices → Hardware**.

| Node | Sensor | Rate | Link | PlatformIO env |
|---|---|---|---|---|
| **A** | AD8232 single-lead ECG | 250 Hz | USB-serial, 115200 baud | `node_a` |
| **B** | MAX30102 red + IR PPG | 100 Hz | Bluetooth LE notifications | `node_b` |
| **Sync** | none: drives the shared sync pulse | 800–1200 ms random | USB-serial | `node_sync` |

Each node also has a `_sim` build (`node_a_sim`, `node_b_sim`) that synthesises the signal on the board. Use it to test the full link and app on a **bare ESP32 with no sensor attached**.

## 1. What you need

- An ESP32 DevKit (ESP32-WROOM-32, `esp32dev`) for each node. Any board with a USB-UART bridge works.
- Node A: an AD8232 module, 3 electrodes and leads.
- Node B: a MAX30102 breakout.
- A laptop with Chrome or Edge, which has Web Serial and Web Bluetooth.
- [PlatformIO](https://platformio.org/install): the VS Code extension, or `pip install platformio`.

> **Safety (ECG):** run the laptop on battery, or use a USB isolator, while electrodes are on a person. Never record with the laptop charging from mains. This is a research prototype, not a medical device.

## 2. Wiring

**Node A: ESP32 ↔ AD8232**

| AD8232 pin | ESP32 pin | Note |
|---|---|---|
| 3.3V | 3V3 | |
| GND | GND | |
| OUTPUT | GPIO 34 | ADC1 input (ADC2 pins don't work while the radio is on) |
| LO+ | GPIO 32 | leads-off detect |
| LO− | GPIO 33 | leads-off detect |
| SDN | not connected | |

Electrodes: RA on the right arm or chest, LA on the left, RL on the right leg or lower right abdomen.

**Node B: ESP32 ↔ MAX30102**

| MAX30102 pin | ESP32 pin | Note |
|---|---|---|
| VIN | 3V3 | |
| GND | GND | |
| SDA | GPIO 21 | I²C, 400 kHz |
| SCL | GPIO 22 | |
| INT | GPIO 19 | open-drain, internal pull-up enabled |

Some cheap MAX30102 boards pull SDA/SCL up to 1.8 V, and the ESP32 then fails to read the sensor reliably. If Node B logs `MAX30102 not found`, check the I²C pull-ups first.

**Sync input (both nodes, optional):** GPIO 4. This is for the clock-sync ground-truth rig. Each edge on this pin is timestamped and sent as a `SYNC_EVENT` frame. Leave it unconnected if you're not using the rig; it has an internal pull-down.

**Sync node (third ESP32):** GPIO 4 is the pulse output; wire it to GPIO 4 on Node A and Node B, with a common GND across all three boards. GPIO 2 (the on-board LED on most DevKits) blinks with the pulse; you can place it where both PPG sensors see it. Flash with `pio run -e node_sync -t upload`, and optionally connect it in the app as *BioBridge Sync Node (USB)*. Its own edges then appear as a third device in the **Clock Sync** tab.

Without the sync node, you can instead connect the same GPIO 4 pins of both nodes to any pulse source shared by the two boards, including a third ESP32 toggling a pin. Space the pulses **irregularly** (e.g. 1 s ± 200 ms, not a steady 1 Hz). A steady rate lines up with BLE connection events and hides part of the delay you're trying to measure. The **Clock Sync** tab then shows the measured error between the two nodes live.

You can change any pin with a build flag in `platformio.ini`, e.g. `-DECG_ADC_GPIO=35` or `-DMAX_INT_GPIO=18`.

## 3. Build and flash

From this `firmware/` folder:

```bash
pio run -e node_a -t upload        # Node A, real AD8232
pio run -e node_b -t upload        # Node B, real MAX30102

pio run -e node_a_sim -t upload    # no sensor: synthetic ECG
pio run -e node_b_sim -t upload    # no sensor: synthetic PPG

pio run -e node_sync -t upload     # sync-pulse rig for clock-sync ground truth
pio run -e node_a_noprobe -t upload    # probes off: for the probe ablation (also node_b_noprobe)

pio test -e native                 # frame encoder unit tests, no board needed
```

If more than one board is plugged in, add `--upload-port /dev/cu.usbserial-XXXX` (macOS) or `COM5` (Windows). On macOS, CH340-based boards may need the WCH driver.

Node B prints human-readable status on its USB serial port, which is useful when it won't connect:

```bash
pio device monitor -e node_b
```

## 4. Connect from the web app

1. Start the app: `cd ../app && npm install && npm run dev`. Open http://localhost:5173 in **Chrome or Edge**.
2. **Node A:** under **Devices → Hardware**, click **Connect** on *BioBridge Node A (USB)*. Pick the board's serial port (CP210x / CH340 / "USB Serial"). Close any serial monitor first, because only one program can hold the port.
3. **Node B:** click **Connect** on *BioBridge Node B (BLE)* and pick **BioBridge-B** in the Bluetooth chooser.
4. Open **Live Data**. You should see the ECG waveform with a computed heart rate (Node A), and the IR/red PPG waveforms (Node B).

**Active connections** shows each link's health. A few hundred *bytes skipped* on Node A right after connecting is normal: opening the port resets the ESP32, and its boot log is skipped. Anything that keeps growing is not normal:

| Symptom | Likely cause |
|---|---|
| CRC errors growing (Node A) | Wrong baud rate, a bad USB cable, or another program writing to the port |
| *lost (seq)* growing (Node A) | Host too slow to read. Rare at this data rate. |
| *lost (seq)* growing (Node B) | Weak BLE link. Move the board closer. |
| Node B connects, but no data | MTU stayed at the default 23 (one sample per frame needs ≥ 25; five need ≥ 49). Check the monitor log for `BLE: MTU`. |
| Flat ECG, *Leads off* tile ≠ 0 | An electrode is off or dry |

**Record** under **Recordings** to save the raw bytes. Export a `.bbrec.jsonl` file and load it with `python ../eval/read_bbrec.py file.bbrec.jsonl`.

## 5. How the firmware works

- [`lib/bbframe`](lib/bbframe/) is the portable C frame encoder and CRC. The native tests check it against the shared golden vectors in `protocol/test-vectors.json`, so it can't silently drift from the app.
- [`src/common/frame_out`](src/common/) is a mutex-protected sender that owns the sequence counter. The sampling task, the main loop and the sync drain all send through it.
- **Timing probes:** both nodes send an empty `TIME_PROBE` frame at random 100–300 ms intervals. It is stamped inside the send lock right before transmission. The host's clock-sync estimator uses these to find the true transport delay floor: fixed-cadence sample frames only hit a few phases of the BLE connection-event grid. See `protocol/FRAME.md`.
- **Node A** ([`src/node_a/main.cpp`](src/node_a/main.cpp)): a hardware timer fires every 4 ms. The ISR timestamps the tick with `esp_timer` and wakes a high-priority task on core 1. That task reads the calibrated ADC and batches 10 samples into one frame. If it ever falls behind by a tick, it closes the batch early, so per-sample timestamps stay correct.
- **Node B** ([`src/node_b/`](src/node_b/)): a register-level MAX30102 driver ([`max30102.cpp`](src/node_b/max30102.cpp)) configured for SpO2 mode, 100 sps, 18-bit, with an interrupt on every sample. The INT edge timestamps the newest sample; the FIFO is drained and samples are packed to fit one BLE notification at the negotiated MTU. The sensor runs on its own oscillator, so its sample clock drifts against the ESP32 clock. Measuring that drift is part of the Paper 1 work.

## Compute placement

Both nodes can run the ECG/PPG processing themselves ([`lib/bbdsp`](lib/bbdsp/)). That is the same C library the web app runs as WebAssembly, so device and browser results are directly comparable. Nodes start in **Raw** mode (samples only, as before). Switch modes from the app's **Compute Placement** tab:

- **Edge:** results only. Heart rate on Node A; pulse rate, SpO2 and signal quality on Node B.
- **Gated:** results, plus samples while the node's quality check is unhappy.
- **Both:** samples and results.

Every 5 s each node reports its mode, the CPU time it spent on DSP, and how many bytes it sent. The app turns these into the traffic, CPU and modelled-power figures. To measure real power instead, put the INA219 in Node B's supply.

`pio test -e native` also runs the DSP library's tests (filters, heart rate, pulse rate, SpO2, signal quality) on your computer.

After changing `lib/bbdsp`, rebuild the browser copy from `app/` with `npm run build:wasm`. That needs Zig: `brew install zig` or `pip install ziglang`.

## Versions

Pinned to `espressif32@6.9.0` (Arduino-ESP32 2.0.17) and `NimBLE-Arduino@1.4.3`. The hardware-timer and NimBLE callback APIs differ in Arduino-ESP32 3.x and NimBLE 2.x, so upgrading needs code changes.
