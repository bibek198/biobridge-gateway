# BioBridge frame protocol v1

The wire format for the BioBridge reference nodes (Node A ECG, Node B PPG, and later the sync node). The same frame is used over USB-serial and over BLE.

The app does **not** hard-code this format. It decodes it through the descriptors in [`app/src/descriptors/library/`](../app/src/descriptors/library/), the same way it decodes any third-party device. This document is the human-readable spec those descriptors encode.

## Frame layout

All multi-byte fields are **little-endian**.

| Offset | Size | Field | Notes |
|---:|---:|---|---|
| 0 | 2 | magic | `0xB1 0x0B` |
| 2 | 1 | version | `1` |
| 3 | 1 | type | see below |
| 4 | 2 | seq | u16 per device, increments on every frame of any type, wraps. Gaps mean lost frames. |
| 6 | 4 | device_ts_us | u32 device clock in µs since boot (`esp_timer`). Wraps every ~71.6 min; receivers unwrap. |
| 10 | 1 | len | payload length, 0–255 |
| 11 | len | payload | type-specific |
| 11+len | 2 | crc | CRC-16/CCITT-FALSE over bytes 2 … 10+len (version through end of payload; magic excluded) |

Total frame length = `13 + len`, so at most 268 bytes.

**CRC-16/CCITT-FALSE** uses poly `0x1021`, init `0xFFFF`, no input or output reflection, and no final XOR. Its check value is `crc("123456789") = 0x29B1`.

## Transports

- **USB-serial (Node A):** frames are sent back to back at 115200 baud. Receivers look for the magic, check the length and CRC, and on failure skip one byte and keep looking. This also skips the ESP32 ROM boot log printed at reset.
- **BLE (Node B):** exactly one frame per GATT notification on service `6b1e0001-b19b-4b1d-9e0a-0b1b2d3c4e5f`, characteristic `6b1e0002-b19b-4b1d-9e0a-0b1b2d3c4e5f` (notify). The firmware sizes each frame to fit `ATT_MTU − 3`.

## Frame types

### `0x01` HELLO

Sent on boot (serial) or on subscribe (BLE), then every 5 s. It carries no timestamp semantics the host relies on.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | protocol version (`1`) |
| 1 | 1 | node kind: `1` = Node A ECG, `2` = Node B PPG, `3` = sync node (sample rate 0) |
| 2 | 2 | nominal sample rate, Hz |
| 4 | 1 | firmware major |
| 5 | 1 | firmware minor |
| 6 | 6 | MAC address |

### `0x02` SAMPLES

`device_ts_us` is the time of the **first** sample. Sample *i* is at `device_ts_us + i × period_us`. A node never puts samples across a gap into one frame: if a tick is missed or the sensor FIFO overflows, it starts a new frame.

**Node A (ECG):**

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | count *n* (10 normally) |
| 1 | 2 | period_us (4000 = 250 Hz) |
| 3 | 2·n | i16 AD8232 output-pin voltage, millivolts (ESP32 calibrated ADC) |

The app's descriptor converts pin millivolts to electrode millivolts as `(mv − 1650) / 100`. This assumes the AD8232 module's 1.65 V mid-rail reference and a gain of about 100. Calibrate the gain against a known signal before reporting amplitudes.

**Node B (PPG):**

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | count *n* (≤ 5, depends on MTU) |
| 1 | 2 | period_us (10000 = 100 Hz) |
| 3 | 6·n | per sample: red u24, IR u24 (MAX30102 18-bit ADC counts) |

### `0x03` SYNC_EVENT

`device_ts_us` is the time the ISR captured a GPIO edge on the node's sync input. This is the hook for the Paper 1 ground-truth rig: one physical pulse, stamped by every node's own clock. The frame itself is sent later, from the main loop, so its arrival time says nothing about transport delay.

The sync node (`firmware/src/node_sync`) drives that pulse, randomly spaced 800–1200 ms and 50 ms wide, and reports its own edges as `SYNC_EVENT` frames over USB-serial. Any rig should space its pulses **irregularly** like this. Ground truth only needs both nodes to see the same edge, and a strictly periodic rig is commensurate with BLE connection intervals.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | edge: `1` rising, `0` falling |
| 1 | 1 | GPIO number |

### `0x04` LEADS_OFF (Node A)

Sent whenever the state changes, and once a second while any lead is off.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | bit0 = LO+ off, bit1 = LO− off |

### `0x05` TIME_PROBE

An empty payload. `device_ts_us` is taken immediately before the frame is handed to the transport (inside the sender's lock), so it is the frame's **send** time. Nodes send probes at **random** 100–300 ms intervals.

The randomness is the point. Sample frames leave at a fixed cadence (Node B every 50 ms), which is commensurate with BLE connection intervals (e.g. 15 ms), so they only ever land at a few phases of the connection-event grid. A minimum-delay clock estimator then cannot see the true delay floor, and its offset is biased by up to a few milliseconds depending on that phase. Probes at random send instants sample every phase. In simulation (5 seeds × 30 min, same seeds with probes on and off), probes cut the transport-aware estimator's cross-device sync error (pulse-pair RMSE) from 1.22 ms to 0.37 ms; see `app/test/syncEval.test.ts` and `docs/research-plan.md` §3.7. Firmware builds with `-DTIME_PROBES=0` (`node_a_noprobe`, `node_b_noprobe`) turn probes off for the same comparison on hardware.

The host decoder learns which messages are stamped at send time from the descriptor (`timestamp.sentAt: "send"`). For sample batches that is also true: they are sent the moment the batch completes.

## Keeping implementations in sync

There are three implementations of this format:

- TypeScript: [`app/src/protocol/`](../app/src/protocol/) encodes; the descriptors decode.
- C: [`firmware/lib/bbframe/`](../firmware/lib/bbframe/).
- Python: [`eval/read_bbrec.py`](../eval/read_bbrec.py).

All three are tested against the golden frames in [`test-vectors.json`](test-vectors.json). That file and `firmware/test/test_bbframe/vectors.h` are generated by `npm run gen:vectors` in `app/`. Don't edit them by hand.

To change the format, bump `version`, update this file, the encoders and the descriptors, then regenerate the vectors.
