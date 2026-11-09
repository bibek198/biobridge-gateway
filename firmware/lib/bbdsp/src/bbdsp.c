#include "bbdsp.h"

// ---- math helpers (no libm: this must build for wasm32-freestanding) --------------------------------

#define BB_PI 3.14159265358979f

/** Taylor series; accurate to ~1e-7 for |x| <= pi/2, which covers every cutoff we design (fc <= fs/4). */
static float bb_sin(float x) {
  float x2 = x * x;
  return x * (1.f - x2 / 6.f * (1.f - x2 / 20.f * (1.f - x2 / 42.f * (1.f - x2 / 72.f * (1.f - x2 / 110.f)))));
}

static float bb_cos(float x) {
  float x2 = x * x;
  return 1.f - x2 / 2.f * (1.f - x2 / 12.f * (1.f - x2 / 30.f * (1.f - x2 / 56.f * (1.f - x2 / 90.f))));
}

static float bb_sqrt(float x) { return x > 0.f ? __builtin_sqrtf(x) : 0.f; }

static uint32_t median_u32(const uint32_t *v, int n) {
  uint32_t s[BBDSP_RR_HISTORY];
  for (int i = 0; i < n; i++) s[i] = v[i];
  for (int i = 1; i < n; i++) {  // insertion sort: n <= 5
    uint32_t k = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > k) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = k;
  }
  return s[n / 2];
}

static float median_f(const float *v, int n) {
  float s[BBDSP_RR_HISTORY];
  for (int i = 0; i < n; i++) s[i] = v[i];
  for (int i = 1; i < n; i++) {
    float k = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > k) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = k;
  }
  return s[n / 2];
}

static void push_history_u32(uint32_t *h, int *n, uint32_t v) {
  if (*n < BBDSP_RR_HISTORY) {
    h[(*n)++] = v;
    return;
  }
  for (int i = 1; i < BBDSP_RR_HISTORY; i++) h[i - 1] = h[i];
  h[BBDSP_RR_HISTORY - 1] = v;
}

static void push_history_f(float *h, int *n, float v) {
  if (*n < BBDSP_RR_HISTORY) {
    h[(*n)++] = v;
    return;
  }
  for (int i = 1; i < BBDSP_RR_HISTORY; i++) h[i - 1] = h[i];
  h[BBDSP_RR_HISTORY - 1] = v;
}

// ---- biquads (RBJ cookbook, Butterworth Q) -----------------------------------------------------------

static void biquad_set(bbdsp_biquad_t *f, float b0, float b1, float b2, float a0, float a1, float a2) {
  f->b0 = b0 / a0;
  f->b1 = b1 / a0;
  f->b2 = b2 / a0;
  f->a1 = a1 / a0;
  f->a2 = a2 / a0;
  f->z1 = f->z2 = 0.f;
}

void bbdsp_biquad_lowpass(bbdsp_biquad_t *f, float fc_hz, float fs_hz) {
  float w0 = 2.f * BB_PI * fc_hz / fs_hz;
  float c = bb_cos(w0), alpha = bb_sin(w0) / (2.f * 0.70710678f);
  biquad_set(f, (1.f - c) / 2.f, 1.f - c, (1.f - c) / 2.f, 1.f + alpha, -2.f * c, 1.f - alpha);
}

void bbdsp_biquad_highpass(bbdsp_biquad_t *f, float fc_hz, float fs_hz) {
  float w0 = 2.f * BB_PI * fc_hz / fs_hz;
  float c = bb_cos(w0), alpha = bb_sin(w0) / (2.f * 0.70710678f);
  biquad_set(f, (1.f + c) / 2.f, -(1.f + c), (1.f + c) / 2.f, 1.f + alpha, -2.f * c, 1.f - alpha);
}

float bbdsp_biquad_step(bbdsp_biquad_t *f, float x) {
  float y = f->b0 * x + f->z1;  // transposed direct form II
  f->z1 = f->b1 * x - f->a1 * y + f->z2;
  f->z2 = f->b2 * x - f->a2 * y;
  return y;
}

// ---- ECG ---------------------------------------------------------------------------------------------

void bbdsp_ecg_init(bbdsp_ecg_t *s, float fs_hz) {
  *s = (bbdsp_ecg_t){0};
  s->fs = fs_hz;
  bbdsp_biquad_highpass(&s->hp, 5.f, fs_hz);
  bbdsp_biquad_lowpass(&s->lp, 15.f, fs_hz);
  s->mwi_len = (int)(0.15f * fs_hz + 0.5f);
  if (s->mwi_len < 1) s->mwi_len = 1;
  if (s->mwi_len > (int)(sizeof s->mwi_buf / sizeof s->mwi_buf[0])) s->mwi_len = (int)(sizeof s->mwi_buf / sizeof s->mwi_buf[0]);
}

int bbdsp_ecg_push(bbdsp_ecg_t *s, float mv, uint32_t t_us, bbdsp_event_t *out) {
  int n = 0;
  s->samples++;

  // Raw history (for the true R apex) and a ~1 s baseline (for the R amplitude).
  s->baseline = s->samples == 1 ? mv : s->baseline + (mv - s->baseline) / s->fs;
  s->raw[s->raw_pos] = mv;
  s->raw_t[s->raw_pos] = t_us;
  s->raw_pos = (s->raw_pos + 1) % BBDSP_ECG_RAW_WINDOW;

  // Band-pass, five-point derivative, squaring, 150 ms moving-window integration (Pan & Tompkins 1985).
  float y = bbdsp_biquad_step(&s->lp, bbdsp_biquad_step(&s->hp, mv));
  float d = (2.f * y + s->d[0] - s->d[2] - 2.f * s->d[3]) / 8.f;
  s->d[3] = s->d[2];
  s->d[2] = s->d[1];
  s->d[1] = s->d[0];
  s->d[0] = y;
  float sq = d * d;
  s->mwi_sum += sq - s->mwi_buf[s->mwi_pos];
  s->mwi_buf[s->mwi_pos] = sq;
  s->mwi_pos = (s->mwi_pos + 1) % s->mwi_len;
  float m = s->mwi_sum / (float)s->mwi_len;

  uint32_t learn = (uint32_t)(2.f * s->fs);
  if (s->samples <= learn) {
    // Learning phase: thresholds from the first 2 s (signal peak ~ max/3, noise ~ mean/2).
    if (m > s->spki * 3.f) s->spki = m / 3.f;
    s->npki += (m / 2.f - s->npki) / (float)s->samples;
    s->threshold = s->npki + 0.25f * (s->spki - s->npki);
  } else if (s->prev_mwi > s->prev2_mwi && s->prev_mwi >= m) {
    // Local maximum of the integrated signal one sample ago.
    float p = s->prev_mwi;
    if (p > s->threshold) {
      // QRS: the R apex is the raw maximum in the last ~250 ms (the integrator lags the R wave).
      int span = (int)(0.25f * s->fs);
      if (span > BBDSP_ECG_RAW_WINDOW) span = BBDSP_ECG_RAW_WINDOW;
      int best = -1;
      for (int k = 1; k <= span; k++) {
        int idx = (s->raw_pos - k + BBDSP_ECG_RAW_WINDOW) % BBDSP_ECG_RAW_WINDOW;
        if (best < 0 || s->raw[idx] > s->raw[best]) best = idx;
      }
      uint32_t rt = s->raw_t[best];
      uint32_t since = rt - s->last_peak_t;
      if (!s->have_peak || since >= 200000u) {  // 200 ms refractory
        s->spki = 0.125f * p + 0.875f * s->spki;
        out[n++] = (bbdsp_event_t){BBDSP_R_PEAK, s->raw[best] - s->baseline, rt};
        if (s->have_peak && since <= 2500000u) {
          push_history_u32(s->rr, &s->rr_n, since);
          if (s->rr_n >= 2) out[n++] = (bbdsp_event_t){BBDSP_HEART_RATE, 60e6f / (float)median_u32(s->rr, s->rr_n), rt};
        }
        s->last_peak_t = rt;
        s->have_peak = 1;
      }
    } else {
      s->npki = 0.125f * p + 0.875f * s->npki;
    }
    s->threshold = s->npki + 0.25f * (s->spki - s->npki);
  }
  s->prev2_mwi = s->prev_mwi;
  s->prev_mwi = m;
  return n;
}

// ---- PPG ---------------------------------------------------------------------------------------------

void bbdsp_ppg_init(bbdsp_ppg_t *s, float fs_hz) {
  *s = (bbdsp_ppg_t){0};
  s->fs = fs_hz;
  bbdsp_biquad_highpass(&s->ir_hp, 0.5f, fs_hz);
  bbdsp_biquad_lowpass(&s->ir_lp, 5.f, fs_hz);
  bbdsp_biquad_highpass(&s->red_hp, 0.5f, fs_hz);
  bbdsp_biquad_lowpass(&s->red_lp, 5.f, fs_hz);
}

static void beat_reset(bbdsp_ppg_t *s) {
  s->beat_len = 0;
  s->ir_max = s->red_max = -3.4e38f;
  s->ir_min = s->red_min = 3.4e38f;
}

/** Correlation of the finished beat (resampled to a fixed length, z-normalised) with the running template. */
static float beat_sqi(bbdsp_ppg_t *s) {
  float v[BBDSP_SQI_POINTS];
  float mean = 0.f;
  for (int i = 0; i < BBDSP_SQI_POINTS; i++) {
    float pos = (float)i * (float)(s->beat_len - 1) / (float)(BBDSP_SQI_POINTS - 1);
    int k = (int)pos;
    float frac = pos - (float)k;
    v[i] = k + 1 < s->beat_len ? s->beat_ir[k] * (1.f - frac) + s->beat_ir[k + 1] * frac : s->beat_ir[k];
    mean += v[i];
  }
  mean /= BBDSP_SQI_POINTS;
  float var = 0.f;
  for (int i = 0; i < BBDSP_SQI_POINTS; i++) {
    v[i] -= mean;
    var += v[i] * v[i];
  }
  float sd = bb_sqrt(var / BBDSP_SQI_POINTS);
  if (sd <= 0.f) return -1.f;
  for (int i = 0; i < BBDSP_SQI_POINTS; i++) v[i] /= sd;

  float corr = -1.f;
  if (s->template_n >= 3) {
    float dot = 0.f;
    for (int i = 0; i < BBDSP_SQI_POINTS; i++) dot += v[i] * s->template_[i];
    corr = dot / BBDSP_SQI_POINTS;
  }
  // The template follows slowly, so one bad beat does not become the reference.
  float a = s->template_n < 3 ? 1.f / (float)(s->template_n + 1) : 0.2f;
  for (int i = 0; i < BBDSP_SQI_POINTS; i++) s->template_[i] += a * (v[i] - s->template_[i]);
  s->template_n++;
  return corr;
}

int bbdsp_ppg_push(bbdsp_ppg_t *s, float red, float ir, uint32_t t_us, bbdsp_event_t *out) {
  int n = 0;
  s->samples++;
  if (s->samples == 1) {
    s->ir_dc = ir;
    s->red_dc = red;
    beat_reset(s);
  }
  float a = 1.f / (1.5f * s->fs);  // ~1.5 s DC tracking
  s->ir_dc += (ir - s->ir_dc) * a;
  s->red_dc += (red - s->red_dc) * a;
  float ir_ac = bbdsp_biquad_step(&s->ir_lp, bbdsp_biquad_step(&s->ir_hp, ir));
  float red_ac = bbdsp_biquad_step(&s->red_lp, bbdsp_biquad_step(&s->red_hp, red));

  // Current beat: shape (for SQI) and peak-to-peak AC per channel (for SpO2).
  float sig = -ir_ac;  // intensity falls as blood volume rises; invert so the pulse goes up
  if (s->beat_len < BBDSP_PPG_BEAT_MAX) s->beat_ir[s->beat_len++] = sig;
  if (ir_ac > s->ir_max) s->ir_max = ir_ac;
  if (ir_ac < s->ir_min) s->ir_min = ir_ac;
  if (red_ac > s->red_max) s->red_max = red_ac;
  if (red_ac < s->red_min) s->red_min = red_ac;

  // Maximum-upstroke detector on the inverted, band-passed IR.
  float slope = (sig - s->prev_s) * s->fs;
  s->prev_s = sig;
  float decay = 1.f - 1.f / (3.f * s->fs);  // ~3 s envelope
  s->slope_env = slope > s->slope_env * decay ? slope : s->slope_env * decay;
  if (s->samples < (uint32_t)(2.f * s->fs)) return 0;  // filters settling

  if (slope > 0.5f * s->slope_env && s->slope_env > 0.f) {
    if (!s->in_upstroke || slope > s->best_slope) {
      s->best_slope = slope;
      s->best_t = t_us - (uint32_t)(500000.f / s->fs);  // finite difference sits half a sample back
    }
    s->in_upstroke = 1;
    return 0;
  }
  if (!s->in_upstroke) return 0;
  s->in_upstroke = 0;
  uint32_t since = s->best_t - s->last_pulse_t;
  if (s->have_pulse && since < 300000u) return 0;  // 300 ms refractory

  out[n++] = (bbdsp_event_t){BBDSP_PULSE, s->best_slope, s->best_t};
  if (s->have_pulse && since <= 2500000u) {
    push_history_u32(s->ibi, &s->ibi_n, since);
    if (s->ibi_n >= 2) out[n++] = (bbdsp_event_t){BBDSP_PULSE_RATE, 60e6f / (float)median_u32(s->ibi, s->ibi_n), s->best_t};

    // The samples since the previous pulse are one cardiac cycle.
    if (s->beat_len >= (int)(0.25f * s->fs) && s->ir_dc > 0.f && s->red_dc > 0.f) {
      float ac_ir = s->ir_max - s->ir_min, ac_red = s->red_max - s->red_min;
      if (ac_ir > 0.f) {
        float r = (ac_red / s->red_dc) / (ac_ir / s->ir_dc);
        float spo2 = 110.f - 25.f * r;
        spo2 = spo2 < 0.f ? 0.f : spo2 > 100.f ? 100.f : spo2;
        push_history_f(s->spo2_hist, &s->spo2_n, spo2);
        out[n++] = (bbdsp_event_t){BBDSP_SPO2, median_f(s->spo2_hist, s->spo2_n), s->best_t};
      }
      float q = beat_sqi(s);
      if (q >= -1.f && s->template_n > 3) out[n++] = (bbdsp_event_t){BBDSP_SQI, q < 0.f ? 0.f : q, s->best_t};
    }
  }
  s->last_pulse_t = s->best_t;
  s->have_pulse = 1;
  beat_reset(s);
  return n;
}
