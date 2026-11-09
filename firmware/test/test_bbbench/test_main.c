// The C benchmark formats must reproduce the TypeScript ones byte for byte (golden frames from
// app/scripts/gen-test-vectors.ts, the same values as protocol/test-vectors.json "bench").
#include <string.h>
#include <unity.h>

#include "bbbench.h"
#include "bench_vectors.h"

void setUp(void) {}
void tearDown(void) {}

static uint8_t out[1024];

#define CHECK(golden, n)                                     \
  do {                                                       \
    TEST_ASSERT_EQUAL_size_t(sizeof(golden), (n));           \
    TEST_ASSERT_EQUAL_HEX8_ARRAY(golden, out, sizeof(golden)); \
  } while (0)

static void test_check_values(void) {
  const uint8_t s[] = "123456789";
  TEST_ASSERT_EQUAL_HEX16(0x4B37, bbbench_crc16_modbus(s, 9));
  TEST_ASSERT_EQUAL_HEX8(0xDD, bbbench_sum8(s, 9));
  TEST_ASSERT_EQUAL_HEX8(0x31, bbbench_xor8(s, 9));
}

static void test_oximeter(void) { CHECK(BENCH_OXIMETER, bbbench_oximeter(out, sizeof out, 0, 55, 97, 72, 20, 7)); }

static void test_be_ecg(void) {
  const int32_t raw[] = {0, 2400, -800, 8388607, -8388608};
  CHECK(BENCH_BE_ECG_SAMPLES, bbbench_be_ecg_samples(out, sizeof out, raw, 5));
  CHECK(BENCH_BE_ECG_STATUS, bbbench_be_ecg_status(out, sizeof out, 87));
}

static void test_bp(void) {
  CHECK(BENCH_BP_RESULT, bbbench_bp_result(out, sizeof out, 123456, 1184, 783, 917, 71));
  CHECK(BENCH_BP_STATUS, bbbench_bp_status(out, sizeof out, 124000, 1805));
}

static void test_float_ppg(void) {
  const float v[] = {1.0f, 0.98f, 1.0125f};
  CHECK(BENCH_FLOAT_PPG, bbbench_float_ppg(out, sizeof out, 1000000, v, 3));
}

static void test_ascii_ecg(void) {
  // TS: asciiEcgLine(1234.7, -350.4, 2) floors the time and rounds the microvolts.
  CHECK(BENCH_ASCII_ECG_LINE, bbbench_ascii_ecg_line((char *)out, sizeof out, 1234, -350, 2));
}

static void test_refuses_small_buffers(void) {
  TEST_ASSERT_EQUAL_size_t(0, bbbench_oximeter(out, 8, 0, 0, 0, 0, 0, 0));
  TEST_ASSERT_EQUAL_size_t(0, bbbench_bp_status(out, 11, 0, 0));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_check_values);
  RUN_TEST(test_oximeter);
  RUN_TEST(test_be_ecg);
  RUN_TEST(test_bp);
  RUN_TEST(test_float_ppg);
  RUN_TEST(test_ascii_ecg);
  RUN_TEST(test_refuses_small_buffers);
  return UNITY_END();
}
