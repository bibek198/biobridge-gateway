// BioBridge DSP: ECG and PPG feature extraction that runs unchanged on the ESP32 and, compiled to
// WebAssembly, in the browser. That is what makes compute placement a fair comparison: moving a stage
// between device and host moves the identical algorithm.
//
// Portable C99. No heap, no libc (not even libm: the few transcendental helpers are local), so it builds
// for wasm32-freestanding. All state lives in caller-owned structs; push one sample at a time.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  BBDSP_R_PEAK = 1,      // value: R amplitude (input units above the local baseline); t: peak time
  BBDSP_HEART_RATE = 2,  // value: bpm, median of the last RR intervals
  BBDSP_PULSE = 3,       // value: upstroke slope; t: maximum-upstroke time of a PPG pulse
  BBDSP_PULSE_RATE = 4,  // value: bpm from PPG
  BBDSP_SPO2 = 5,        // value: % (ratio-of-ratios, uncalibrated linear model 110 - 25 R)
  BBDSP_SQI = 6,         // value: 0..1 PPG signal quality (beat-shape correlation with a running template)
} bbdsp_event_kind_t;

typedef struct {
  uint8_t kind;
  float value;
  uint32_t t_us;  // device clock, wraps like the frame timestamps
} bbdsp_event_t;

#define BBDSP_MAX_EVENTS_PER_PUSH 4

// ---- second-order IIR section ----------------------------------------------------------------------
typedef struct {
  float b0, b1, b2, a1, a2;
  float z1, z2;
} bbdsp_biquad_t;

void bbdsp_biquad_lowpass(bbdsp_biquad_t *f, float fc_hz, float fs_hz);
void bbdsp_biquad_highpass(bbdsp_biquad_t *f, float fc_hz, float fs_hz);
float bbdsp_biquad_step(bbdsp_biquad_t *f, float x);

// ---- ECG: Pan-Tompkins style R-peak detection ------------------------------------------------------
#define BBDSP_ECG_MAX_FS 1000
#define BBDSP_ECG_RAW_WINDOW 128  // raw ring buffer (250 ms at up to 500 Hz) for locating the true R apex
#define BBDSP_RR_HISTORY 5

typedef struct {
  float fs;
  bbdsp_biquad_t hp, lp;      // 5-15 Hz band-pass
  float d[4];                 // derivative history
  float mwi_buf[BBDSP_ECG_MAX_FS / 6];  // 150 ms moving-window integrator
  int mwi_len, mwi_pos;
  float mwi_sum;
  float raw[BBDSP_ECG_RAW_WINDOW];
  uint32_t raw_t[BBDSP_ECG_RAW_WINDOW];
  int raw_pos;
  float baseline;
  // adaptive thresholds on the integrated signal
  float spki, npki, threshold;
  float prev_mwi, prev2_mwi;
  uint32_t last_peak_t;
  int have_peak;
  uint32_t rr[BBDSP_RR_HISTORY];
  int rr_n;
  uint32_t samples;
} bbdsp_ecg_t;

void bbdsp_ecg_init(bbdsp_ecg_t *s, float fs_hz);
/** Push one sample (mV). Writes up to BBDSP_MAX_EVENTS_PER_PUSH events; returns how many. */
int bbdsp_ecg_push(bbdsp_ecg_t *s, float mv, uint32_t t_us, bbdsp_event_t *out);

// ---- PPG: pulses, pulse rate, SpO2, signal quality --------------------------------------------------
#define BBDSP_SQI_POINTS 32
#define BBDSP_PPG_BEAT_MAX 256  // samples kept for the current beat (2.56 s at 100 Hz)

typedef struct {
  float fs;
  bbdsp_biquad_t ir_hp, ir_lp, red_hp, red_lp;  // 0.5-5 Hz band-pass per channel
  float ir_dc, red_dc;                          // slow baselines
  float prev_s;                                 // previous band-passed, inverted IR
  float slope_env;                              // decaying envelope of the upstroke slope
  int in_upstroke;
  float best_slope;
  uint32_t best_t;
  uint32_t last_pulse_t;
  int have_pulse;
  uint32_t ibi[BBDSP_RR_HISTORY];
  int ibi_n;
  // current beat, for AC amplitudes and the beat-shape SQI
  float beat_ir[BBDSP_PPG_BEAT_MAX];
  int beat_len;
  float ir_max, ir_min, red_max, red_min;
  float template_[BBDSP_SQI_POINTS];
  int template_n;
  float spo2_hist[BBDSP_RR_HISTORY];
  int spo2_n;
  uint32_t samples;
} bbdsp_ppg_t;

void bbdsp_ppg_init(bbdsp_ppg_t *s, float fs_hz);
/** Push one red/IR sample pair (raw intensity, any scale; intensity falls as blood volume rises). */
int bbdsp_ppg_push(bbdsp_ppg_t *s, float red, float ir, uint32_t t_us, bbdsp_event_t *out);

#ifdef __cplusplus
}
#endif
