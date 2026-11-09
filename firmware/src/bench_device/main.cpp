// Paper 2 benchmark on hardware: an ESP32 impersonating one of the benchmark's third-party-style devices,
// chosen at build time (BENCH_FORMAT), so descriptor synthesis can be evaluated on a real serial link.
// Formats come from lib/bbbench (byte-identical to the app's simulators, tested against the same golden
// frames); datasheets are in app/src/bench/devices.ts. Signals are synthetic (no sensor needed).
//
//   pio run -e bench_oximeter -t upload     (also bench_be_ecg, bench_bp, bench_float_ppg, bench_ascii_ecg)

#include <Arduino.h>
#include <esp_timer.h>
#include <math.h>

#include "bbbench.h"

#define FMT_OXIMETER 1
#define FMT_BE_ECG 2
#define FMT_BP 3
#define FMT_FLOAT_PPG 4
#define FMT_ASCII_ECG 5

#ifndef BENCH_FORMAT
#define BENCH_FORMAT FMT_OXIMETER
#endif

// Each format uses only some of these helpers.
// ---- synthetic subject: 72 bpm, SpO2 97 % (same shapes as the app's simulator) ------------------------

static const float BEAT_US = 60e6f / 72.f;

static float gaussian(float x, float c, float w, float h) { return h * expf(-((x - c) * (x - c)) / (2.f * w * w)); }

static float phase(int64_t t_us) { return fmodf((float)t_us, BEAT_US) / BEAT_US; }

__attribute__((unused)) static float ecg_mv(int64_t t_us) {
  float p = phase(t_us);
  return gaussian(p, 0.08f, 0.02f, 0.15f) + gaussian(p, 0.16f, 0.006f, -0.15f) + gaussian(p, 0.18f, 0.008f, 1.2f) +
         gaussian(p, 0.2f, 0.006f, -0.3f) + gaussian(p, 0.35f, 0.04f, 0.25f) + ((float)(esp_random() % 21) - 10.f) * 0.001f;
}

/** Blood-volume pulse 0..~1, arriving 220 ms after the R-peak. */
__attribute__((unused)) static float ppg_pulse(int64_t t_us) {
  float x = phase(t_us - 220000) - 0.18f;
  if (x < 0) x += 1.f;
  auto shape = [](float u) { return gaussian(u, 0.13f, 0.05f, 1.f) + gaussian(u, 0.38f, 0.07f, 0.4f); };
  return shape(x) + shape(x - 1.f) + shape(x + 1.f);
}

static uint8_t buf[1024];

__attribute__((unused)) static void send(size_t n) {
  if (n) Serial.write(buf, n);
}

// ---- formats ---------------------------------------------------------------------------------------

#if BENCH_FORMAT == FMT_OXIMETER
static const uint32_t BAUD = 19200;
static void run(int64_t now) {  // 50 packets/s
  static int64_t next = 0;
  static uint8_t counter = 0;
  if (now < next) return;
  next = now + 20000;
  uint8_t pleth = (uint8_t)lroundf(10.f + 80.f * fminf(1.f, ppg_pulse(now)));
  send(bbbench_oximeter(buf, sizeof buf, 0, pleth, 97, 72, 20, counter++));
}

#elif BENCH_FORMAT == FMT_BE_ECG
static const uint32_t BAUD = 230400;
static void run(int64_t now) {  // 500 Hz, 25 samples per packet, status every 5 s
  static int64_t next_sample = 0, next_status = 0;
  static int32_t raw[25];
  static uint8_t n = 0;
  while (now >= next_sample) {
    raw[n++] = (int32_t)lroundf(ecg_mv(next_sample) / 0.0005f);
    next_sample += 2000;
    if (n == 25) {
      send(bbbench_be_ecg_samples(buf, sizeof buf, raw, n));
      n = 0;
    }
  }
  if (now >= next_status) {
    next_status = now + 5000000;
    send(bbbench_be_ecg_status(buf, sizeof buf, 87));
  }
}

#elif BENCH_FORMAT == FMT_BP
static const uint32_t BAUD = 9600;
static void run(int64_t now) {  // 1 Hz cuff status; a result after each 10 s inflate/deflate cycle
  static int64_t next = 0, cycle_start = 0;
  if (now < next) return;
  next = now + 1000000;
  float s = (float)(now - cycle_start) / 1e6f;
  float cuff = s < 3.f ? 60.f * s : s < 9.f ? 180.f * (1.f - (s - 3.f) / 6.f) : 0.f;
  uint32_t uptime_ms = (uint32_t)(now / 1000);
  send(bbbench_bp_status(buf, sizeof buf, uptime_ms, (uint16_t)lroundf(cuff * 10.f)));
  if (s >= 9.5f) {
    send(bbbench_bp_result(buf, sizeof buf, uptime_ms, 1184, 783, 917, 72));
    cycle_start = now + 500000;
  }
}

#elif BENCH_FORMAT == FMT_FLOAT_PPG
static const uint32_t BAUD = 230400;
static void run(int64_t now) {  // 100 Hz, 10 samples per packet, sent when the last sample is taken
  static int64_t next_sample = 0;
  static float v[10];
  static uint32_t first_us = 0;
  static uint8_t n = 0;
  while (now >= next_sample) {
    if (n == 0) first_us = (uint32_t)next_sample;
    float wander = 0.01f * sinf(2.f * 3.14159265f * (float)next_sample / 4e6f);
    v[n++] = 1.f + wander - 0.02f * ppg_pulse(next_sample);
    next_sample += 10000;
    if (n == 10) {
      send(bbbench_float_ppg(buf, sizeof buf, first_us, v, n));
      n = 0;
    }
  }
}

#elif BENCH_FORMAT == FMT_ASCII_ECG
static const uint32_t BAUD = 115200;
static void run(int64_t now) {  // 200 Hz lines after a header
  static int64_t next_sample = -1;
  if (next_sample < 0) {
    Serial.print(BBBENCH_ASCII_ECG_HEADER);
    next_sample = now;
  }
  while (now >= next_sample) {
    char line[48];
    size_t n = bbbench_ascii_ecg_line(line, sizeof line, (uint32_t)(next_sample / 1000), (int32_t)lroundf(ecg_mv(next_sample) * 1000.f), 0);
    Serial.write((const uint8_t *)line, n);
    next_sample += 5000;
  }
}

#else
#error "Unknown BENCH_FORMAT"
#endif

void setup() {
  Serial.setTxBufferSize(2048);
  Serial.begin(BAUD);
}

void loop() {
  run(esp_timer_get_time());
  delay(1);
}
