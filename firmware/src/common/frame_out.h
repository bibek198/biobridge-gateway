// Thread-safe frame sender shared by both nodes: owns the sequence counter and serialises writes
// from the sampling task, the main loop and the sync-input drain.
#pragma once

#include <stddef.h>
#include <stdint.h>

// Timing probes on by default; build with -DTIME_PROBES=0 for the with/without ablation (Paper 1).
#ifndef TIME_PROBES
#define TIME_PROBES 1
#endif

/** Delivers one complete frame (serial write, BLE notify, ...). Returns false if it was dropped. */
typedef bool (*frame_sink_fn)(const uint8_t *frame, size_t len);

void frame_out_begin(frame_sink_fn sink);

/** Encodes and sends one frame; increments seq even if the sink drops it, so the host sees the gap. */
bool frame_out_send(uint8_t type, uint32_t device_ts_us, const uint8_t *payload, uint8_t payload_len);

/**
 * Sends an empty TIME_PROBE frame, timestamped inside the send lock immediately before it is handed to
 * the sink, so its timestamp is its send time. Call at random intervals (see protocol/FRAME.md).
 */
bool frame_out_probe();

/** Sends a HELLO for this node, stamped now. */
bool frame_out_hello(uint8_t node_kind, uint16_t sample_rate_hz);

/** Bytes handed to the sink since the last call (for STATS: what the link actually carried). */
uint32_t frame_out_take_tx_bytes();

/** Frames attempted and frames the sink refused, for diagnostics. */
uint32_t frame_out_sent();
uint32_t frame_out_dropped();
