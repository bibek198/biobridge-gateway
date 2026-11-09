// WebAssembly entry points for bbdsp (browser side of compute placement). Not built by PlatformIO: it lives
// outside lib/bbdsp/src. Built by app/scripts/build-wasm.mjs into app/src/dsp/bbdsp.wasm.
//
// No heap: a fixed pool of detector instances addressed by small integer handles. Events from the last
// push are read back through accessor functions, so JS never depends on struct layout.

#include "../src/bbdsp.h"

#define POOL 32  // one detector per connection (browser modules and simulated nodes share an instance)
#define EXPORT(name) __attribute__((export_name(name)))

static bbdsp_ecg_t ecg_pool[POOL];
static bbdsp_ppg_t ppg_pool[POOL];
static int ecg_used[POOL], ppg_used[POOL];
static bbdsp_event_t events[BBDSP_MAX_EVENTS_PER_PUSH];

EXPORT("ecg_create") int ecg_create(float fs_hz) {
  for (int h = 0; h < POOL; h++) {
    if (!ecg_used[h]) {
      ecg_used[h] = 1;
      bbdsp_ecg_init(&ecg_pool[h], fs_hz);
      return h;
    }
  }
  return -1;
}

EXPORT("ecg_free") void ecg_free(int h) {
  if (h >= 0 && h < POOL) ecg_used[h] = 0;
}

EXPORT("ecg_push") int ecg_push(int h, float mv, uint32_t t_us) {
  if (h < 0 || h >= POOL || !ecg_used[h]) return 0;
  return bbdsp_ecg_push(&ecg_pool[h], mv, t_us, events);
}

EXPORT("ppg_create") int ppg_create(float fs_hz) {
  for (int h = 0; h < POOL; h++) {
    if (!ppg_used[h]) {
      ppg_used[h] = 1;
      bbdsp_ppg_init(&ppg_pool[h], fs_hz);
      return h;
    }
  }
  return -1;
}

EXPORT("ppg_free") void ppg_free(int h) {
  if (h >= 0 && h < POOL) ppg_used[h] = 0;
}

EXPORT("ppg_push") int ppg_push(int h, float red, float ir, uint32_t t_us) {
  if (h < 0 || h >= POOL || !ppg_used[h]) return 0;
  return bbdsp_ppg_push(&ppg_pool[h], red, ir, t_us, events);
}

EXPORT("ev_kind") int ev_kind(int i) { return events[i].kind; }
EXPORT("ev_value") float ev_value(int i) { return events[i].value; }
EXPORT("ev_t") uint32_t ev_t(int i) { return events[i].t_us; }
