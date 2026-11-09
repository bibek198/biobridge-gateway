// Byte formats of the Paper 2 benchmark's third-party-style devices, so an ESP32 can impersonate them
// (src/bench_device). Mirrors app/src/bench/formats.ts; both are tested against the same golden frames
// (protocol/test-vectors.json "bench", firmware/test/test_bbbench). Datasheets: app/src/bench/devices.ts.
// Each builder writes one frame into out and returns its length (0 if out is too small).
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint16_t bbbench_crc16_modbus(const uint8_t *data, size_t len);
uint8_t bbbench_sum8(const uint8_t *data, size_t len);
uint8_t bbbench_xor8(const uint8_t *data, size_t len);

/** Fingertip oximeter: AA 55 | status | pleth | SpO2 | pulse | PI (0.1 %) | counter | XOR(bytes 2..7). 9 bytes. */
size_t bbbench_oximeter(uint8_t *out, size_t cap, uint8_t status, uint8_t pleth, uint8_t spo2, uint8_t pulse, uint8_t pi10, uint8_t counter);

/** ECG front-end board samples: 5A A5 | LEN u16be | 0x10 | N | N x i24be (0.5 uV/LSB) | SUM8. */
size_t bbbench_be_ecg_samples(uint8_t *out, size_t cap, const int32_t *raw, uint8_t n);
/** ECG front-end board status: 5A A5 | LEN u16be | 0x20 | battery % | SUM8. */
size_t bbbench_be_ecg_status(uint8_t *out, size_t cap, uint8_t battery_pct);

/** BP monitor result: 'B' 'P' | LEN | 0x01 | uptime ms u32 | sys, dia, map u16 (0.1 mmHg) | pulse u8 | CRC-16/MODBUS LE. */
size_t bbbench_bp_result(uint8_t *out, size_t cap, uint32_t uptime_ms, uint16_t sys10, uint16_t dia10, uint16_t map10, uint8_t pulse);
/** BP monitor status: 'B' 'P' | LEN | 0x02 | uptime ms u32 | cuff u16 (0.1 mmHg) | CRC-16/MODBUS LE. */
size_t bbbench_bp_status(uint8_t *out, size_t cap, uint32_t uptime_ms, uint16_t cuff10);

/** USB PPG module: A0 0A | LEN u16le | t_us u32 | N | N x f32le | CRC-16/CCITT-FALSE LE over LEN..body. */
size_t bbbench_float_ppg(uint8_t *out, size_t cap, uint32_t first_sample_us, const float *samples, uint8_t n);

/** Lab ECG amplifier line "t_ms,ecg_uV,lo\r\n" (NUL-terminated; returns length without the NUL). */
size_t bbbench_ascii_ecg_line(char *out, size_t cap, uint32_t t_ms, int32_t uV, uint8_t leads_off);
#define BBBENCH_ASCII_ECG_HEADER "t_ms,ecg_uV,lo\r\n"

#ifdef __cplusplus
}
#endif
