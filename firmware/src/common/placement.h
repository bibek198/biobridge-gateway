// Compute placement: where the ECG/PPG processing runs, switchable at runtime by the host (CONFIG frame).
//   RAW   stream samples; the browser runs the DSP (as WebAssembly, the same C code)
//   EDGE  the node runs the DSP and sends only DERIVED results
//   GATED DERIVED always; samples only while the node's own quality check says a person should look
//   BOTH  samples and DERIVED, to compare device and browser on the same data
// STATS frames report the mode, the CPU time spent in DSP and the bytes sent, every 5 s.
#pragma once

#include <stdint.h>

#include "bbdsp.h"
#include "bbframe.h"

void placement_begin(uint8_t initial_mode);
uint8_t placement_mode();

/** Handles a decoded host frame; returns true if it was a CONFIG we applied. */
bool placement_on_frame(const bb_frame_t &f);

bool placement_runs_dsp();
/** Whether to send a samples frame now, given whether the node's quality check wants raw data. */
bool placement_sends_samples(bool raw_wanted);

void placement_add_dsp_us(uint32_t us);
/** Sends one bbdsp event as a DERIVED frame. */
void placement_send_event(const bbdsp_event_t &e);
/** Call from the main loop: sends STATS every 5 s and right after a mode change. */
void placement_tick(uint32_t now_ms);
