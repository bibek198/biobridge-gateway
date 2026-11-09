// Sync input for the Paper 1 ground-truth rig: a shared GPIO pulse wired to every node. Each edge is
// timestamped in the ISR with the node's own clock and reported as a SYNC_EVENT frame, so the host can
// compare what each device's clock says about one physical instant.
#pragma once

#include <stdint.h>

/** gpio < 0 disables the feature. Uses an internal pull-down so a floating pin stays quiet. */
void sync_input_begin(int gpio);

/** Sends SYNC_EVENT frames for edges captured since the last call. Call from a task, not an ISR. */
void sync_input_drain();
