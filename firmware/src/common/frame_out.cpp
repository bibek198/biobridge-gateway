#include "frame_out.h"

#include <Arduino.h>
#include <esp_mac.h>
#include <esp_timer.h>

#include "bbframe.h"
#include "version.h"

static frame_sink_fn s_sink = nullptr;
static SemaphoreHandle_t s_lock = nullptr;
static uint16_t s_seq = 0;
static uint32_t s_sent = 0;
static uint32_t s_dropped = 0;
static uint32_t s_tx_bytes = 0;

void frame_out_begin(frame_sink_fn sink) {
  s_sink = sink;
  if (!s_lock) s_lock = xSemaphoreCreateMutex();
}

bool frame_out_send(uint8_t type, uint32_t device_ts_us, const uint8_t *payload, uint8_t payload_len) {
  uint8_t frame[BB_MAX_FRAME];
  xSemaphoreTake(s_lock, portMAX_DELAY);
  size_t n = bb_encode(frame, sizeof frame, type, s_seq++, device_ts_us, payload, payload_len);
  bool ok = n > 0 && s_sink && s_sink(frame, n);
  s_sent++;
  if (ok) s_tx_bytes += n;
  else s_dropped++;
  xSemaphoreGive(s_lock);
  return ok;
}

bool frame_out_probe() {
  uint8_t frame[BB_OVERHEAD];
  xSemaphoreTake(s_lock, portMAX_DELAY);
  size_t n = bb_encode(frame, sizeof frame, BB_TIME_PROBE, s_seq++, (uint32_t)esp_timer_get_time(), nullptr, 0);
  bool ok = n > 0 && s_sink && s_sink(frame, n);
  s_sent++;
  if (ok) s_tx_bytes += n;
  else s_dropped++;
  xSemaphoreGive(s_lock);
  return ok;
}

bool frame_out_hello(uint8_t node_kind, uint16_t sample_rate_hz) {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  uint8_t payload[16];
  size_t n = bb_hello_payload(payload, sizeof payload, node_kind, sample_rate_hz, FW_VERSION_MAJOR, FW_VERSION_MINOR, mac);
  return frame_out_send(BB_HELLO, (uint32_t)esp_timer_get_time(), payload, (uint8_t)n);
}

uint32_t frame_out_take_tx_bytes() {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  uint32_t n = s_tx_bytes;
  s_tx_bytes = 0;
  xSemaphoreGive(s_lock);
  return n;
}

uint32_t frame_out_sent() { return s_sent; }
uint32_t frame_out_dropped() { return s_dropped; }
