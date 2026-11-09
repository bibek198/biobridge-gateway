// Native unit tests: the C encoder must reproduce the golden frames byte-for-byte.
// vectors.h is generated from the TypeScript reference (app/scripts/gen-test-vectors.ts).
#include <string.h>
#include <unity.h>

#include "bbframe.h"
#include "vectors.h"

void setUp(void) {}
void tearDown(void) {}

static void test_crc_check_value(void) {
  const char *s = "123456789";
  TEST_ASSERT_EQUAL_HEX16(0x29B1, bb_crc16((const uint8_t *)s, strlen(s)));
}

static void test_golden_frames(void) {
  uint8_t out[BB_MAX_FRAME];
  for (size_t i = 0; i < BB_TEST_VECTOR_COUNT; i++) {
    const bb_test_vector_t *v = &BB_TEST_VECTORS[i];
    size_t n = bb_encode(out, sizeof out, v->type, v->seq, v->device_ts_us, v->payload, (uint8_t)v->payload_len);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(v->frame_len, n, v->name);
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(v->frame, out, v->frame_len, v->name);
  }
}

static void test_hello_payload_matches_vector(void) {
  const uint8_t mac[6] = {0x24, 0x6f, 0x28, 0xaa, 0xbb, 0xcc};
  uint8_t out[32];
  size_t n = bb_hello_payload(out, sizeof out, BB_NODE_A_ECG, 250, 0, 1, mac);
  TEST_ASSERT_EQUAL_size_t(BB_TEST_VECTORS[0].payload_len, n);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(BB_TEST_VECTORS[0].payload, out, n);
}

static void test_encode_refuses_small_buffer(void) {
  uint8_t out[BB_OVERHEAD + 1];
  const uint8_t payload[2] = {1, 2};
  TEST_ASSERT_EQUAL_size_t(0, bb_encode(out, sizeof out, BB_SAMPLES, 0, 0, payload, 2));
}

static void test_writer_flags_overflow(void) {
  uint8_t buf[3];
  bb_writer_t w;
  bb_w_init(&w, buf, sizeof buf);
  bb_w_u24(&w, 0x123456);
  TEST_ASSERT_FALSE(w.overflow);
  bb_w_u8(&w, 1);
  TEST_ASSERT_TRUE(w.overflow);
  TEST_ASSERT_EQUAL_size_t(3, w.len);
}

static void test_decoder_reads_every_golden_frame_with_noise_between(void) {
  bb_decoder_t d;
  bb_decoder_init(&d);
  const uint8_t noise[] = {0x00, 0xb1, 0x42, 0xb1, 0x0b, 0xff};  // includes a false magic
  size_t found = 0;
  for (size_t i = 0; i < BB_TEST_VECTOR_COUNT; i++) {
    const bb_test_vector_t *v = &BB_TEST_VECTORS[i];
    bb_frame_t f;
    for (size_t k = 0; k < sizeof noise; k++) TEST_ASSERT_FALSE(bb_decoder_push(&d, noise[k], &f));
    bool got = false;
    for (size_t k = 0; k < v->frame_len; k++) got = bb_decoder_push(&d, v->frame[k], &f);
    TEST_ASSERT_TRUE_MESSAGE(got, v->name);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(v->type, f.type, v->name);
    TEST_ASSERT_EQUAL_UINT16(v->seq, f.seq);
    TEST_ASSERT_EQUAL_UINT32(v->device_ts_us, f.device_ts_us);
    TEST_ASSERT_EQUAL_size_t(v->payload_len, f.payload_len);
    if (v->payload_len) TEST_ASSERT_EQUAL_HEX8_ARRAY(v->payload, f.payload, v->payload_len);
    found++;
  }
  TEST_ASSERT_EQUAL_size_t(BB_TEST_VECTOR_COUNT, found);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_crc_check_value);
  RUN_TEST(test_golden_frames);
  RUN_TEST(test_hello_payload_matches_vector);
  RUN_TEST(test_encode_refuses_small_buffer);
  RUN_TEST(test_writer_flags_overflow);
  RUN_TEST(test_decoder_reads_every_golden_frame_with_noise_between);
  return UNITY_END();
}
