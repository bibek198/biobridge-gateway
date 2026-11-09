#include "placement.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "frame_out.h"

static volatile uint8_t s_mode = BB_MODE_RAW;
static volatile bool s_stats_due = true;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_dsp_us = 0;
static uint32_t s_last_stats_ms = 0;

void placement_begin(uint8_t initial_mode) { s_mode = initial_mode; }

uint8_t placement_mode() { return s_mode; }

bool placement_on_frame(const bb_frame_t &f) {
  if (f.type != BB_CONFIG || f.payload_len < 1 || f.payload[0] > BB_MODE_BOTH) return false;
  s_mode = f.payload[0];
  s_stats_due = true;  // acknowledge with a STATS frame carrying the new mode
  return true;
}

bool placement_runs_dsp() { return s_mode != BB_MODE_RAW; }

bool placement_sends_samples(bool raw_wanted) {
  switch (s_mode) {
    case BB_MODE_EDGE:
      return false;
    case BB_MODE_GATED:
      return raw_wanted;
    default:
      return true;
  }
}

void placement_add_dsp_us(uint32_t us) {
  portENTER_CRITICAL(&s_mux);
  s_dsp_us += us;
  portEXIT_CRITICAL(&s_mux);
}

void placement_send_event(const bbdsp_event_t &e) {
  uint8_t payload[5];
  bb_writer_t w;
  bb_w_init(&w, payload, sizeof payload);
  bb_w_u8(&w, e.kind);
  uint32_t bits;
  memcpy(&bits, &e.value, 4);  // f32 little-endian (both ESP32 and the wire are LE)
  bb_w_u32(&w, bits);
  frame_out_send(BB_DERIVED, e.t_us, payload, (uint8_t)w.len);
}

void placement_tick(uint32_t now_ms) {
  uint32_t period = now_ms - s_last_stats_ms;
  if (!s_stats_due && period < 5000) return;
  s_stats_due = false;
  s_last_stats_ms = now_ms;
  portENTER_CRITICAL(&s_mux);
  uint32_t dsp_us = s_dsp_us;
  s_dsp_us = 0;
  portEXIT_CRITICAL(&s_mux);
  uint8_t payload[11];
  bb_writer_t w;
  bb_w_init(&w, payload, sizeof payload);
  bb_w_u8(&w, s_mode);
  bb_w_u32(&w, dsp_us);
  bb_w_u32(&w, frame_out_take_tx_bytes());
  bb_w_u16(&w, (uint16_t)(period > 65535 ? 65535 : period));
  frame_out_send(BB_STATS, (uint32_t)esp_timer_get_time(), payload, (uint8_t)w.len);
}
