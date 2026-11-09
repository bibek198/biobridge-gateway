#include "bbframe.h"

#include <string.h>

uint16_t bb_crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

size_t bb_encode(uint8_t *out, size_t out_cap, uint8_t type, uint16_t seq, uint32_t device_ts_us,
                 const uint8_t *payload, uint8_t payload_len) {
  size_t total = BB_OVERHEAD + payload_len;
  if (out_cap < total) return 0;
  out[0] = BB_MAGIC0;
  out[1] = BB_MAGIC1;
  out[2] = BB_VERSION;
  out[3] = type;
  out[4] = (uint8_t)(seq & 0xFF);
  out[5] = (uint8_t)(seq >> 8);
  out[6] = (uint8_t)(device_ts_us & 0xFF);
  out[7] = (uint8_t)(device_ts_us >> 8);
  out[8] = (uint8_t)(device_ts_us >> 16);
  out[9] = (uint8_t)(device_ts_us >> 24);
  out[10] = payload_len;
  if (payload_len > 0) memcpy(out + BB_HEADER_LEN, payload, payload_len);
  // CRC covers version..end of payload; the magic is excluded.
  uint16_t crc = bb_crc16(out + 2, BB_HEADER_LEN - 2 + payload_len);
  out[BB_HEADER_LEN + payload_len] = (uint8_t)(crc & 0xFF);
  out[BB_HEADER_LEN + payload_len + 1] = (uint8_t)(crc >> 8);
  return total;
}

void bb_w_init(bb_writer_t *w, uint8_t *buf, size_t cap) {
  w->buf = buf;
  w->cap = cap;
  w->len = 0;
  w->overflow = false;
}

void bb_w_u8(bb_writer_t *w, uint8_t v) {
  if (w->len >= w->cap) {
    w->overflow = true;
    return;
  }
  w->buf[w->len++] = v;
}

void bb_w_u16(bb_writer_t *w, uint16_t v) {
  bb_w_u8(w, (uint8_t)(v & 0xFF));
  bb_w_u8(w, (uint8_t)(v >> 8));
}

void bb_w_i16(bb_writer_t *w, int16_t v) { bb_w_u16(w, (uint16_t)v); }

void bb_w_u24(bb_writer_t *w, uint32_t v) {
  bb_w_u8(w, (uint8_t)(v & 0xFF));
  bb_w_u8(w, (uint8_t)(v >> 8));
  bb_w_u8(w, (uint8_t)(v >> 16));
}

void bb_w_u32(bb_writer_t *w, uint32_t v) {
  bb_w_u16(w, (uint16_t)(v & 0xFFFF));
  bb_w_u16(w, (uint16_t)(v >> 16));
}

void bb_w_bytes(bb_writer_t *w, const uint8_t *src, size_t n) {
  for (size_t i = 0; i < n; i++) bb_w_u8(w, src[i]);
}

size_t bb_hello_payload(uint8_t *out, size_t cap, uint8_t node_kind, uint16_t sample_rate_hz, uint8_t fw_major,
                        uint8_t fw_minor, const uint8_t mac[6]) {
  bb_writer_t w;
  bb_w_init(&w, out, cap);
  bb_w_u8(&w, BB_PROTOCOL_VERSION);
  bb_w_u8(&w, node_kind);
  bb_w_u16(&w, sample_rate_hz);
  bb_w_u8(&w, fw_major);
  bb_w_u8(&w, fw_minor);
  bb_w_bytes(&w, mac, 6);
  return w.overflow ? 0 : w.len;
}

void bb_decoder_init(bb_decoder_t *d) {
  d->len = 0;
  d->consumed = 0;
}

static void drop(bb_decoder_t *d, size_t n) {
  memmove(d->buf, d->buf + n, d->len - n);
  d->len -= n;
}

bool bb_decoder_push(bb_decoder_t *d, uint8_t byte, bb_frame_t *out) {
  if (d->consumed) {
    drop(d, d->consumed);
    d->consumed = 0;
  }
  if (d->len == sizeof d->buf) drop(d, 1);  // cannot happen with valid lengths; keeps us safe anyway
  d->buf[d->len++] = byte;

  for (;;) {
    if (d->len >= 1 && d->buf[0] != BB_MAGIC0) {
      drop(d, 1);
      continue;
    }
    // Magic plus the version byte: rejects most false magics at once instead of waiting out their bogus length.
    if ((d->len >= 2 && d->buf[1] != BB_MAGIC1) || (d->len >= 3 && d->buf[2] != BB_VERSION)) {
      drop(d, 1);
      continue;
    }
    if (d->len < BB_HEADER_LEN) return false;
    size_t total = BB_OVERHEAD + d->buf[10];
    if (d->len < total) return false;
    uint16_t want = (uint16_t)(d->buf[total - 2] | (d->buf[total - 1] << 8));
    if (bb_crc16(d->buf + 2, total - 4) != want) {
      drop(d, 1);  // false magic or corruption: hunt again
      continue;
    }
    out->type = d->buf[3];
    out->seq = (uint16_t)(d->buf[4] | (d->buf[5] << 8));
    out->device_ts_us = (uint32_t)d->buf[6] | ((uint32_t)d->buf[7] << 8) | ((uint32_t)d->buf[8] << 16) | ((uint32_t)d->buf[9] << 24);
    out->payload = d->buf + BB_HEADER_LEN;
    out->payload_len = d->buf[10];
    d->consumed = total;
    return true;
  }
}
