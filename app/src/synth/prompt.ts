import typesSource from "../descriptors/types.ts?raw";
import type { BenchDevice } from "../bench/devices";
import { VOCABULARY } from "../bench/vocabulary";
import type { RecordedChunk } from "../session/recording";

// Prompt construction for descriptor synthesis. The model gets what a human integrator would get: the
// device documentation, a raw capture, the transport it is connected through, and the platform's channel
// vocabulary. It never sees the ground-truth descriptor or the scoring.

export const SYSTEM_PROMPT = `You write device descriptors for BioBridge, a gateway that decodes biomedical sensor data. A descriptor is a JSON document that tells a generic decoder how a device's bytes map to named channels; it is the only thing you produce. You will receive the device's documentation, a capture of its raw output, the transport it is connected through, and the channels the platform needs. After each descriptor you write, a validator and a verifier run it against the capture and report what they found; use that report to fix the descriptor.

The descriptor schema, as TypeScript types (your JSON must conform; the comments explain the semantics):

<schema>
${typesSource}
</schema>

Decoding rules that the types do not spell out:
- Offsets in conditions and fields count from the first byte of the frame, including the magic bytes. With per-chunk framing, a frame is one BLE notification.
- magic-length-crc: frame length = headerLength + (value of the length field) + checksum width (2 bytes for crc16-*, 1 for sum8/xor8). The checksum covers bytes from crc.start up to the byte just before the checksum. magic-fixed: the checksum, if any, is the last 1 or 2 bytes of the frame.
- A frame is decoded by the first message whose match conditions all hold; a message without match conditions matches every frame.
- value = raw × scale + bias. Channels must be in the units of the platform vocabulary, so scale raw values accordingly.
- For a samples field, sample i is stamped timestamp + i × periodUs. A message without a timestamp is stamped with host arrival time.
- Delimited text: each line is trimmed; channel-value mode reads "name<separator>value"; columns mode maps column indices to channels; lines that do not parse are skipped.
- Use exactly the required channel ids. Extra channels are allowed. The platform supplies plausibility bounds and display hints itself, so you may omit plausibility.
- Set timestamp.sentAt to "send" only when the documentation says the device transmits the message as soon as its newest timestamp is reached; otherwise use "event".
- Use the given transport object verbatim.

Reply format: reason as much as you need, then give the complete descriptor in a single \`\`\`json fenced block. Every reply must contain the whole descriptor, not a fragment or a diff.`;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

/** Mostly printable ASCII (text protocols are shown as text, binary ones as hex). */
function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let ok = 0;
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) ok++;
  return ok / bytes.length > 0.95;
}

/** A capture excerpt the way an integrator would look at it: hex dump, notification list, or text lines. */
export function captureExcerpt(chunks: RecordedChunk[], transportKind: "serial" | "ble", maxBytes = 2048): string {
  if (chunks.length === 0) return "(no data captured)";
  const t0 = chunks[0].t;
  const durationS = (chunks[chunks.length - 1].t - t0) / 1000;
  const total = chunks.reduce((n, c) => n + c.bytes.length, 0);

  if (transportKind === "ble") {
    const shown = chunks.slice(0, 40);
    const lines = shown.map((c, i) => `#${String(i).padStart(2, "0")} +${(c.t - t0).toFixed(1).padStart(7)} ms  (${c.bytes.length} B)  ${hex(c.bytes)}`);
    return `${chunks.length} notifications, ${total} bytes over ${durationS.toFixed(1)} s. First ${shown.length} notifications (time since first, size, hex):\n${lines.join("\n")}`;
  }

  const stream = new Uint8Array(Math.min(total, maxBytes));
  let o = 0;
  for (const c of chunks) {
    if (o >= stream.length) break;
    const take = c.bytes.subarray(0, stream.length - o);
    stream.set(take, o);
    o += take.length;
  }
  const head = `${total} bytes over ${durationS.toFixed(1)} s on the serial port. First ${stream.length} bytes`;
  if (looksTextual(stream)) {
    const text = new TextDecoder().decode(stream).replace(/\r/g, "\\r");
    return `${head}, as text (\\r shown explicitly, lines end in \\n):\n${text}`;
  }
  const rows: string[] = [];
  for (let i = 0; i < stream.length; i += 16) {
    rows.push(`${i.toString(16).padStart(5, "0")}  ${hex(stream.subarray(i, i + 16))}`);
  }
  return `${head}, as hex (offset, 16 bytes per row):\n${rows.join("\n")}`;
}

export function taskPrompt(device: BenchDevice, deviceChunks: RecordedChunk[]): string {
  const t = device.groundTruth.transport;
  const channels = device.requiredChannels
    .map((id) => {
      const v = VOCABULARY[id];
      return `- ${id}${v.unit ? ` (${v.unit})` : ""}: ${v.description}`;
    })
    .join("\n");
  return `## Device documentation

${device.datasheet}

## Transport (use verbatim)

${JSON.stringify(t)}

## Required channels (platform vocabulary)

${channels}

## Raw capture

${captureExcerpt(deviceChunks, t.kind)}

Write the descriptor. Use "${device.id}" as its id.`;
}
