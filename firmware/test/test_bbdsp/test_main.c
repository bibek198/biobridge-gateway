// Native tests of the DSP library that runs on the nodes in "edge" mode (and, as Wasm, in the browser).
#include <math.h>
#include <unity.h>

#include "bbdsp.h"

void setUp(void) {}
void tearDown(void) {}

static float gauss(float x, float c, float w, float h) { return h * expf(-((x - c) * (x - c)) / (2.f * w * w)); }

/** Synthetic lead-II-like beat (P, Q, R, S, T) at phase 0..1. */
static float ecg_beat(float ph) {
  return gauss(ph, 0.08f, 0.02f, 0.15f) + gauss(ph, 0.16f, 0.006f, -0.15f) + gauss(ph, 0.18f, 0.008f, 1.2f) +
         gauss(ph, 0.20f, 0.006f, -0.3f) + gauss(ph, 0.35f, 0.04f, 0.25f);
}

static void test_ecg_heart_rate_75bpm(void) {
  bbdsp_ecg_t s;
  bbdsp_ecg_init(&s, 250.f);
  bbdsp_event_t ev[BBDSP_MAX_EVENTS_PER_PUSH];
  int peaks = 0;
  float last_hr = 0.f;
  const float beat_s = 60.f / 75.f;
  for (int i = 0; i < 250 * 40; i++) {
    float t = i / 250.f;
    float mv = ecg_beat(fmodf(t, beat_s) / beat_s) + 0.3f * sinf(2.f * 3.14159f * t / 3.f);  // baseline wander
    int n = bbdsp_ecg_push(&s, mv, (uint32_t)(t * 1e6f), ev);
    for (int k = 0; k < n; k++) {
      if (ev[k].kind == BBDSP_R_PEAK) peaks++;
      if (ev[k].kind == BBDSP_HEART_RATE) last_hr = ev[k].value;
    }
  }
  TEST_ASSERT_INT_WITHIN(3, 47, peaks);  // 40 s at 75 bpm = 50 beats, minus the 2 s learning phase
  TEST_ASSERT_FLOAT_WITHIN(1.0f, 75.f, last_hr);
}

static void test_ppg_rate_and_spo2(void) {
  bbdsp_ppg_t s;
  bbdsp_ppg_init(&s, 100.f);
  bbdsp_event_t ev[BBDSP_MAX_EVENTS_PER_PUSH];
  float pr = 0.f, spo2 = 0.f, sqi = 0.f;
  const float beat_s = 60.f / 66.f, target_spo2 = 95.f, r = (110.f - target_spo2) / 25.f;
  for (int i = 0; i < 100 * 40; i++) {
    float t = i / 100.f;
    float x = fmodf(t, beat_s) / beat_s;
    float pulse = gauss(x, 0.13f, 0.05f, 1.f) + gauss(x, 0.38f, 0.07f, 0.4f) + gauss(x - 1.f, 0.13f, 0.05f, 1.f);
    float ir = 120000.f * (1.f - 0.02f * pulse), red = 90000.f * (1.f - r * 0.02f * pulse);
    int n = bbdsp_ppg_push(&s, red, ir, (uint32_t)(t * 1e6f), ev);
    for (int k = 0; k < n; k++) {
      if (ev[k].kind == BBDSP_PULSE_RATE) pr = ev[k].value;
      if (ev[k].kind == BBDSP_SPO2) spo2 = ev[k].value;
      if (ev[k].kind == BBDSP_SQI) sqi = ev[k].value;
    }
  }
  TEST_ASSERT_FLOAT_WITHIN(1.5f, 66.f, pr);
  TEST_ASSERT_FLOAT_WITHIN(1.5f, target_spo2, spo2);
  TEST_ASSERT_TRUE(sqi > 0.95f);
}

static void test_biquad_lowpass_dc_gain_is_one(void) {
  bbdsp_biquad_t f;
  bbdsp_biquad_lowpass(&f, 15.f, 250.f);
  float y = 0.f;
  for (int i = 0; i < 2000; i++) y = bbdsp_biquad_step(&f, 1.f);
  TEST_ASSERT_FLOAT_WITHIN(1e-4f, 1.f, y);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_biquad_lowpass_dc_gain_is_one);
  RUN_TEST(test_ecg_heart_rate_75bpm);
  RUN_TEST(test_ppg_rate_and_spo2);
  return UNITY_END();
}
