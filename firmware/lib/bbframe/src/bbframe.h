// BioBridge frame v1 encoder (spec: protocol/FRAME.md). Portable C, no Arduino/ESP-IDF dependencies,
// so it is unit-tested natively against protocol/test-vectors.json (see test/test_bbframe).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BB_MAGIC0 0xB1
#define BB_MAGIC1 0x0B
#define BB_VERSION 1
#define BB_HEADER_LEN 11
#define BB_CRC_LEN 2
#define BB_MAX_PAYLOAD 255
#define BB_MAX_FRAME (BB_HEADER_LEN + BB_MAX_PAYLOAD + BB_CRC_LEN)
/** Bytes a frame adds around its payload. */
#define BB_OVERHEAD (BB_HEADER_LEN + BB_CRC_LEN)

enum {
  BB_HELLO = 0x01,
  BB_SAMPLES = 0x02,
  BB_SYNC_EVENT = 0x03,
  BB_LEADS_OFF = 0x04,
  BB_TIME_PROBE = 0x05,
};

enum {
  BB_NODE_A_ECG = 1,
  BB_NODE_B_PPG = 2,
  BB_NODE_SYNC = 3,
};

#define BB_PROTOCOL_VERSION 1

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
uint16_t bb_crc16(const uint8_t *data, size_t len);

/** Writes a complete frame into out. Returns the frame length, or 0 if out is too small. */
size_t bb_encode(uint8_t *out, size_t out_cap, uint8_t type, uint16_t seq, uint32_t device_ts_us,
                 const uint8_t *payload, uint8_t payload_len);

/** Little-endian payload builder. Writes past cap set overflow instead of overrunning. */
typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t len;
  bool overflow;
} bb_writer_t;

void bb_w_init(bb_writer_t *w, uint8_t *buf, size_t cap);
void bb_w_u8(bb_writer_t *w, uint8_t v);
void bb_w_u16(bb_writer_t *w, uint16_t v);
void bb_w_i16(bb_writer_t *w, int16_t v);
void bb_w_u24(bb_writer_t *w, uint32_t v);
void bb_w_u32(bb_writer_t *w, uint32_t v);
void bb_w_bytes(bb_writer_t *w, const uint8_t *src, size_t n);

/** HELLO payload: protocol u8 | node_kind u8 | sample_rate_hz u16 | fw_major u8 | fw_minor u8 | mac[6]. */
size_t bb_hello_payload(uint8_t *out, size_t cap, uint8_t node_kind, uint16_t sample_rate_hz, uint8_t fw_major,
                        uint8_t fw_minor, const uint8_t mac[6]);

#ifdef __cplusplus
}
#endif
