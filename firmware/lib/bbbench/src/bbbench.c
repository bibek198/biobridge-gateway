#include "bbbench.h"

#include <string.h>

#include "bbframe.h"  // bb_crc16 (CRC-16/CCITT-FALSE)

uint16_t bbbench_crc16_modbus(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc & 1) ? (uint16_t)((crc >> 1) ^ 0xA001) : (uint16_t)(crc >> 1);
  }
  return crc;
}

uint8_t bbbench_sum8(const uint8_t *data, size_t len) {
  uint8_t s = 0;
  for (size_t i = 0; i < len; i++) s = (uint8_t)(s + data[i]);
  return s;
}

uint8_t bbbench_xor8(const uint8_t *data, size_t len) {
  uint8_t x = 0;
  for (size_t i = 0; i < len; i++) x ^= data[i];
  return x;
}

size_t bbbench_oximeter(uint8_t *out, size_t cap, uint8_t status, uint8_t pleth, uint8_t spo2, uint8_t pulse, uint8_t pi10, uint8_t counter) {
  if (cap < 9) return 0;
  const uint8_t f[9] = {0xAA, 0x55, status, pleth, spo2, pulse, pi10, counter, 0};
  memcpy(out, f, 9);
  out[8] = bbbench_xor8(out + 2, 6);
  return 9;
}

static size_t be_frame(uint8_t *out, size_t cap, const uint8_t *body, size_t body_len) {
  size_t total = 4 + body_len + 1;
  if (cap < total || body_len > 0xFFFF) return 0;
  out[0] = 0x5A;
  out[1] = 0xA5;
  out[2] = (uint8_t)(body_len >> 8);  // big-endian length
  out[3] = (uint8_t)(body_len & 0xFF);
  memcpy(out + 4, body, body_len);
  out[total - 1] = bbbench_sum8(out + 2, total - 3);
  return total;
}

size_t bbbench_be_ecg_samples(uint8_t *out, size_t cap, const int32_t *raw, uint8_t n) {
  uint8_t body[2 + 3 * 255];
  body[0] = 0x10;
  body[1] = n;
  for (uint8_t i = 0; i < n; i++) {
    uint32_t u = (uint32_t)raw[i] & 0xFFFFFF;  // 24-bit two's complement, big-endian
    body[2 + 3 * i] = (uint8_t)(u >> 16);
    body[3 + 3 * i] = (uint8_t)(u >> 8);
    body[4 + 3 * i] = (uint8_t)u;
  }
  return be_frame(out, cap, body, 2 + 3 * (size_t)n);
}

size_t bbbench_be_ecg_status(uint8_t *out, size_t cap, uint8_t battery_pct) {
  const uint8_t body[2] = {0x20, battery_pct};
  return be_frame(out, cap, body, 2);
}

static size_t bp_frame(uint8_t *out, size_t cap, const uint8_t *payload, uint8_t len) {
  size_t total = 3 + (size_t)len + 2;
  if (cap < total) return 0;
  out[0] = 'B';
  out[1] = 'P';
  out[2] = len;
  memcpy(out + 3, payload, len);
  uint16_t crc = bbbench_crc16_modbus(out, total - 2);
  out[total - 2] = (uint8_t)(crc & 0xFF);
  out[total - 1] = (uint8_t)(crc >> 8);
  return total;
}

static void put_u16le(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}

static void put_u32le(uint8_t *p, uint32_t v) {
  put_u16le(p, (uint16_t)v);
  put_u16le(p + 2, (uint16_t)(v >> 16));
}

size_t bbbench_bp_result(uint8_t *out, size_t cap, uint32_t uptime_ms, uint16_t sys10, uint16_t dia10, uint16_t map10, uint8_t pulse) {
  uint8_t p[12];
  p[0] = 0x01;
  put_u32le(p + 1, uptime_ms);
  put_u16le(p + 5, sys10);
  put_u16le(p + 7, dia10);
  put_u16le(p + 9, map10);
  p[11] = pulse;
  return bp_frame(out, cap, p, sizeof p);
}

size_t bbbench_bp_status(uint8_t *out, size_t cap, uint32_t uptime_ms, uint16_t cuff10) {
  uint8_t p[7];
  p[0] = 0x02;
  put_u32le(p + 1, uptime_ms);
  put_u16le(p + 5, cuff10);
  return bp_frame(out, cap, p, sizeof p);
}

size_t bbbench_float_ppg(uint8_t *out, size_t cap, uint32_t first_sample_us, const float *samples, uint8_t n) {
  size_t body = 5 + 4 * (size_t)n;
  size_t total = 4 + body + 2;
  if (cap < total) return 0;
  out[0] = 0xA0;
  out[1] = 0x0A;
  put_u16le(out + 2, (uint16_t)body);
  put_u32le(out + 4, first_sample_us);
  out[8] = n;
  for (uint8_t i = 0; i < n; i++) {
    uint32_t bits;
    memcpy(&bits, &samples[i], 4);  // IEEE-754 single, written little-endian
    put_u32le(out + 9 + 4 * i, bits);
  }
  uint16_t crc = bb_crc16(out + 2, total - 4);
  put_u16le(out + total - 2, crc);
  return total;
}

/** Minimal decimal formatting (no printf needed, so this also builds for tiny targets). */
static size_t put_int(char *p, int64_t v) {
  char tmp[24];
  size_t n = 0, len = 0;
  uint64_t u = v < 0 ? (uint64_t)(-v) : (uint64_t)v;
  do {
    tmp[n++] = (char)('0' + u % 10);
    u /= 10;
  } while (u);
  if (v < 0) p[len++] = '-';
  while (n) p[len++] = tmp[--n];
  return len;
}

size_t bbbench_ascii_ecg_line(char *out, size_t cap, uint32_t t_ms, int32_t uV, uint8_t leads_off) {
  char buf[48];
  size_t n = put_int(buf, t_ms);
  buf[n++] = ',';
  n += put_int(buf + n, uV);
  buf[n++] = ',';
  n += put_int(buf + n, leads_off);
  buf[n++] = '\r';
  buf[n++] = '\n';
  if (cap < n + 1) return 0;
  memcpy(out, buf, n);
  out[n] = '\0';
  return n;
}
