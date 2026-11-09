// BioBridge Node A: AD8232 single-lead ECG -> BioBridge frames over USB-serial.
//
// Sampling: a hardware timer fires every 4 ms (250 Hz). Its ISR timestamps the tick with esp_timer
// (µs since boot) and wakes the sampling task, which reads the ADC and batches 10 samples per
// SAMPLES frame. The frame carries the first sample's timestamp; the rest are period-spaced, which
// holds because the timer is hardware-paced. A missed tick closes the batch early so timestamps never lie.
//
// SENSOR_SIM=1 builds synthesise the ECG on the board (no AD8232 needed) to test transport and app.

#include <Arduino.h>
#include <esp_timer.h>
#include <math.h>

#include "bbframe.h"
#include "common/frame_out.h"
#include "common/sync_input.h"

#ifndef ECG_ADC_GPIO
#define ECG_ADC_GPIO 34  // AD8232 OUTPUT (ADC1; ADC2 pins clash with Wi-Fi/BLE)
#endif
#ifndef LO_PLUS_GPIO
#define LO_PLUS_GPIO 32
#endif
#ifndef LO_MINUS_GPIO
#define LO_MINUS_GPIO 33
#endif
#ifndef SYNC_GPIO
#define SYNC_GPIO 4
#endif
#ifndef SENSOR_SIM
#define SENSOR_SIM 0
#endif

static const uint32_t SAMPLE_RATE_HZ = 250;
static const uint32_t PERIOD_US = 1000000 / SAMPLE_RATE_HZ;
static const uint8_t BATCH = 10;
static const uint32_t SERIAL_BAUD = 115200;

static hw_timer_t *s_timer = nullptr;
static TaskHandle_t s_sample_task = nullptr;
static volatile uint32_t s_tick_ts_us = 0;

static void IRAM_ATTR on_sample_tick() {
  s_tick_ts_us = (uint32_t)esp_timer_get_time();
  BaseType_t woken = pdFALSE;
  vTaskNotifyGiveFromISR(s_sample_task, &woken);
  if (woken) portYIELD_FROM_ISR();
}

static bool serial_sink(const uint8_t *frame, size_t len) {
  // Never block the sampler on a slow host: drop the frame (the host sees a seq gap) if the TX buffer is full.
  if ((size_t)Serial.availableForWrite() < len) return false;
  return Serial.write(frame, len) == len;
}

#if SENSOR_SIM
static float gaussian(float x, float c, float w, float h) { return h * expf(-((x - c) * (x - c)) / (2 * w * w)); }

/** Same synthetic beat as the app's simulator, at a fixed 72 bpm. Returns AD8232 output-pin millivolts. */
static int16_t read_ecg_mv(uint32_t ts_us) {
  const float beat_us = 60e6f / 72.0f;
  float phase = fmodf((float)ts_us, beat_us) / beat_us;
  float mv = gaussian(phase, 0.08f, 0.02f, 0.15f) + gaussian(phase, 0.16f, 0.006f, -0.15f) +
             gaussian(phase, 0.18f, 0.008f, 1.2f) + gaussian(phase, 0.2f, 0.006f, -0.3f) +
             gaussian(phase, 0.35f, 0.04f, 0.25f);
  return (int16_t)lroundf(1650.0f + 100.0f * mv + (float)(esp_random() % 5) - 2.0f);
}
static uint8_t read_leads_off() { return 0; }
#else
static int16_t read_ecg_mv(uint32_t) { return (int16_t)analogReadMilliVolts(ECG_ADC_GPIO); }
static uint8_t read_leads_off() {
  return (digitalRead(LO_PLUS_GPIO) ? 0x01 : 0) | (digitalRead(LO_MINUS_GPIO) ? 0x02 : 0);
}
#endif

static void sample_task(void *) {
  uint8_t payload[3 + 2 * BATCH];
  bb_writer_t w;
  uint8_t count = 0;
  uint32_t batch_ts = 0;
  int16_t samples[BATCH];

  auto flush = [&]() {
    if (count == 0) return;
    bb_w_init(&w, payload, sizeof payload);
    bb_w_u8(&w, count);
    bb_w_u16(&w, (uint16_t)PERIOD_US);
    for (uint8_t i = 0; i < count; i++) bb_w_i16(&w, samples[i]);
    frame_out_send(BB_SAMPLES, batch_ts, payload, (uint8_t)w.len);
    count = 0;
  };

  for (;;) {
    uint32_t ticks = ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    uint32_t ts = s_tick_ts_us;
    if (ticks > 1) flush();  // we fell behind: start a fresh batch at the current tick
    if (count == 0) batch_ts = ts;
    samples[count++] = read_ecg_mv(ts);
    if (count == BATCH) flush();
  }
}

void setup() {
  Serial.setTxBufferSize(4096);
  Serial.begin(SERIAL_BAUD);

#if !SENSOR_SIM
  analogReadResolution(12);
  analogSetPinAttenuation(ECG_ADC_GPIO, ADC_11db);  // full 0-3.3 V range of the AD8232 output
  pinMode(LO_PLUS_GPIO, INPUT);
  pinMode(LO_MINUS_GPIO, INPUT);
#endif

  frame_out_begin(serial_sink);
  sync_input_begin(SYNC_GPIO);
  frame_out_hello(BB_NODE_A_ECG, SAMPLE_RATE_HZ);

  xTaskCreatePinnedToCore(sample_task, "ecg", 4096, nullptr, configMAX_PRIORITIES - 2, &s_sample_task, 1);

  // Arduino-ESP32 2.x timer API: timer 0, prescaler 80 -> 1 MHz ticks.
  s_timer = timerBegin(0, 80, true);
  timerAttachInterrupt(s_timer, &on_sample_tick, true);
  timerAlarmWrite(s_timer, PERIOD_US, true);
  timerAlarmEnable(s_timer);
}

void loop() {
  static uint32_t last_hello_ms = 0;
  static uint32_t last_leads_ms = 0;
  static uint8_t last_leads = 0xFF;

  uint32_t now_ms = millis();
  if (now_ms - last_hello_ms >= 5000) {
    last_hello_ms = now_ms;
    frame_out_hello(BB_NODE_A_ECG, SAMPLE_RATE_HZ);
  }

  // Report leads-off on every change, and once a second while any lead is off.
  uint8_t leads = read_leads_off();
  if (leads != last_leads || (leads != 0 && now_ms - last_leads_ms >= 1000)) {
    last_leads = leads;
    last_leads_ms = now_ms;
    frame_out_send(BB_LEADS_OFF, (uint32_t)esp_timer_get_time(), &leads, 1);
  }

  // Timing probes at random 100-300 ms intervals: random send phases let the host find the true
  // transport delay floor (fixed-cadence sample frames alias against USB/BLE scheduling).
#if TIME_PROBES
  static uint32_t next_probe_ms = 0;
  if ((int32_t)(now_ms - next_probe_ms) >= 0) {
    frame_out_probe();
    next_probe_ms = now_ms + 100 + esp_random() % 200;
  }
#endif

  sync_input_drain();
  delay(1);
}
