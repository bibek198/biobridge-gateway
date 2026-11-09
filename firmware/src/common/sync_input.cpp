#include "sync_input.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "bbframe.h"
#include "frame_out.h"

typedef struct {
  uint32_t ts_us;
  uint8_t edge;
} sync_edge_t;

static QueueHandle_t s_edges = nullptr;
static int s_gpio = -1;

static void IRAM_ATTR on_edge() {
  // Timestamp first: everything after this line is latency we do not want in the measurement.
  sync_edge_t e = {(uint32_t)esp_timer_get_time(), (uint8_t)digitalRead(s_gpio)};
  BaseType_t woken = pdFALSE;
  xQueueSendFromISR(s_edges, &e, &woken);
  if (woken) portYIELD_FROM_ISR();
}

void sync_input_begin(int gpio) {
  if (gpio < 0) return;
  s_gpio = gpio;
  s_edges = xQueueCreate(16, sizeof(sync_edge_t));
  pinMode(gpio, INPUT_PULLDOWN);
  attachInterrupt(digitalPinToInterrupt(gpio), on_edge, CHANGE);
}

void sync_input_drain() {
  if (!s_edges) return;
  sync_edge_t e;
  while (xQueueReceive(s_edges, &e, 0) == pdTRUE) {
    uint8_t payload[2] = {e.edge, (uint8_t)s_gpio};
    frame_out_send(BB_SYNC_EVENT, e.ts_us, payload, sizeof payload);
  }
}
