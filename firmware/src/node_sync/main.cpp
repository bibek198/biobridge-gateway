// BioBridge sync node: the Paper 1 ground-truth rig.
//
// Drives one pulse train on SYNC_OUT_GPIO (wire it to GPIO 4 of every node) and an LED (place it where
// both PPG sensors can see it, optional). Each node timestamps the same physical edge with its own
// clock and reports it as SYNC_EVENT; the host compares their mapped times. The sync node is also a
// timed device itself: it reports its own edges, HELLO and timing probes over USB-serial.
//
// Pulse spacing is RANDOM (800-1200 ms). A steady 1 Hz train is commensurate with BLE connection
// intervals (1000 ms / 15 ms repeats every 3 pulses) and would only ever sample a few phases of the
// connection-event grid. See protocol/FRAME.md and docs/research-plan.md section 3.7.

#include <Arduino.h>
#include <esp_timer.h>

#include "bbframe.h"
#include "common/frame_out.h"

#ifndef SYNC_OUT_GPIO
#define SYNC_OUT_GPIO 4
#endif
#ifndef SYNC_LED_GPIO
#define SYNC_LED_GPIO 2  // on-board LED on most ESP32 DevKits
#endif

static const uint32_t PULSE_WIDTH_US = 50000;
static const uint32_t MIN_GAP_US = 800000;
static const uint32_t GAP_SPAN_US = 400000;

typedef struct {
  uint32_t ts_us;
  uint8_t edge;
} edge_t;

static esp_timer_handle_t s_timer = nullptr;
static QueueHandle_t s_edges = nullptr;
static volatile uint8_t s_level = 0;

static bool serial_sink(const uint8_t *frame, size_t len) {
  if ((size_t)Serial.availableForWrite() < len) return false;
  return Serial.write(frame, len) == len;
}

// Runs in the esp_timer task. The edge time recorded here is the sync node's own view; the ground truth
// for node-to-node sync is that every node sees the same physical edge, whatever its exact time.
static void on_edge_timer(void *) {
  s_level ^= 1;
  gpio_set_level((gpio_num_t)SYNC_OUT_GPIO, s_level);
  gpio_set_level((gpio_num_t)SYNC_LED_GPIO, s_level);
  edge_t e = {(uint32_t)esp_timer_get_time(), s_level};
  xQueueSend(s_edges, &e, 0);
  uint64_t next_us = s_level ? PULSE_WIDTH_US : MIN_GAP_US - PULSE_WIDTH_US + (esp_random() % GAP_SPAN_US);
  esp_timer_start_once(s_timer, next_us);
}

void setup() {
  Serial.setTxBufferSize(1024);
  Serial.begin(115200);
  pinMode(SYNC_OUT_GPIO, OUTPUT);
  pinMode(SYNC_LED_GPIO, OUTPUT);
  digitalWrite(SYNC_OUT_GPIO, LOW);
  digitalWrite(SYNC_LED_GPIO, LOW);

  s_edges = xQueueCreate(16, sizeof(edge_t));
  frame_out_begin(serial_sink);
  frame_out_hello(BB_NODE_SYNC, 0);

  esp_timer_create_args_t args = {};
  args.callback = &on_edge_timer;
  args.name = "sync";
  esp_timer_create(&args, &s_timer);
  esp_timer_start_once(s_timer, MIN_GAP_US);
}

void loop() {
  static uint32_t last_hello_ms = 0;
  uint32_t now_ms = millis();

  edge_t e;
  while (xQueueReceive(s_edges, &e, 0) == pdTRUE) {
    uint8_t payload[2] = {e.edge, (uint8_t)SYNC_OUT_GPIO};
    frame_out_send(BB_SYNC_EVENT, e.ts_us, payload, sizeof payload);
  }

  if (now_ms - last_hello_ms >= 5000) {
    last_hello_ms = now_ms;
    frame_out_hello(BB_NODE_SYNC, 0);
  }

#if TIME_PROBES
  static uint32_t next_probe_ms = 0;
  if ((int32_t)(now_ms - next_probe_ms) >= 0) {
    frame_out_probe();
    next_probe_ms = now_ms + 100 + esp_random() % 200;
  }
#endif
  delay(1);
}
