#!/usr/bin/env python3
"""Load a BioBridge recording (.bbrec.jsonl) into decoded samples.

The recording carries each connection's descriptor, so this interprets the same JSON the app does.
Supports the binary descriptor features used by the reference nodes and the BLE HRS profile
(magic-length-crc and per-chunk framing; scalar, samples and hex fields) and delimited text.

    python eval/read_bbrec.py recording.bbrec.jsonl            # summary + first rows
    python eval/read_bbrec.py recording.bbrec.jsonl --csv out.csv
    python eval/read_bbrec.py --selftest                       # check against protocol/test-vectors.json

As a library:  from read_bbrec import load;  rows, meta = load(path)
Each row: {conn, label, channel, value, unit, host_ms, device_us, seq}.  host_ms is the chunk's
arrival time; device_us is the device clock (unwrapped) or None.  Use pandas.DataFrame(rows).
Standard library only; pandas is optional.
"""
from __future__ import annotations

import argparse
import base64
import csv
import json
import operator
import struct
import sys
from functools import reduce
from pathlib import Path

FORMATS = {
    "u8": "<B", "i8": "<b", "u16le": "<H", "u16be": ">H", "i16le": "<h", "i16be": ">h",
    "u32le": "<I", "u32be": ">I", "i32le": "<i", "i32be": ">i", "f32le": "<f", "f32be": ">f",
}
SIZES = {**{k: struct.calcsize(v) for k, v in FORMATS.items()}, "u24le": 3, "u24be": 3, "i24le": 3, "i24be": 3}


def read_num(b: bytes, off: int, typ: str):
    size = SIZES[typ]
    if off < 0 or off + size > len(b):
        return None
    if typ in FORMATS:
        return struct.unpack_from(FORMATS[typ], b, off)[0]
    raw = b[off:off + 3]
    v = int.from_bytes(raw, "little" if typ.endswith("le") else "big")
    return v - 0x1000000 if typ.startswith("i") and v & 0x800000 else v


def crc16_ccitt_false(b: bytes) -> int:
    crc = 0xFFFF
    for byte in b:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def crc16_modbus(b: bytes) -> int:
    crc = 0xFFFF
    for byte in b:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


CHECKSUMS = {
    "crc16-ccitt-false": (2, crc16_ccitt_false),
    "crc16-modbus": (2, crc16_modbus),
    "sum8": (1, lambda b: sum(b) & 0xFF),
    "xor8": (1, lambda b: reduce(operator.xor, b, 0)),
}


def _checksum_ok(frame: bytes, spec) -> bool:
    if not spec:
        return True
    width, fn = CHECKSUMS[spec["kind"]]
    at = len(frame) - width
    want = frame[at] if width == 1 else read_num(frame, at, "u16be" if spec.get("endian") == "be" else "u16le")
    return fn(frame[spec["start"]:at]) == want


def _matches(b: bytes, conds) -> bool:
    for c in conds or []:
        v = read_num(b, c["offset"], c["type"])
        if v is None or (v & c["mask"] if "mask" in c else v) != c["equals"]:
            return False
    return True


def _scaled(raw, f):
    return round(raw * f.get("scale", 1) + f.get("bias", 0), 9)


class Decoder:
    """Streaming decoder for one connection; push() returns (samples, info)."""

    def __init__(self, d: dict):
        self.d = d
        self.buf = b""
        self.epochs: dict[str, list] = {}  # timestamp layout -> [last_raw, epoch]
        self.stats = {"frames_ok": 0, "crc_errors": 0, "bytes_discarded": 0, "malformed": 0}
        self.units = {c["id"]: c.get("unit") for c in d.get("channels", [])}

    def push(self, chunk: bytes):
        kind = self.d["framing"]["kind"]
        if kind == "per-chunk":
            return self._interpret(chunk)
        if kind == "delimited":
            return self._text(chunk)
        return self._magic(chunk)  # magic-length-crc or magic-fixed

    def _magic(self, chunk: bytes):
        fr = self.d["framing"]
        magic = bytes(fr["magic"])
        self.buf += chunk
        samples, info, pos = [], {}, 0
        while True:
            start = self.buf.find(magic, pos)
            if start < 0:
                keep = next((k for k in range(len(magic) - 1, 0, -1) if self.buf.endswith(magic[:k])), 0)
                keep = min(keep, len(self.buf) - pos)
                self.stats["bytes_discarded"] += len(self.buf) - pos - keep
                pos = len(self.buf) - keep
                break
            self.stats["bytes_discarded"] += start - pos
            pos = start
            if fr["kind"] == "magic-fixed":
                total, spec = fr["frameLength"], fr.get("checksum")
            else:
                if len(self.buf) - pos < fr["headerLength"]:
                    break
                spec = fr["crc"]
                total = fr["headerLength"] + read_num(self.buf, pos + fr["lengthOffset"], fr["lengthType"]) + CHECKSUMS[spec["kind"]][0]
                if total > fr["maxFrameLength"]:
                    pos += 1
                    self.stats["bytes_discarded"] += 1
                    continue
            if len(self.buf) - pos < total:
                break
            frame = self.buf[pos:pos + total]
            if not _checksum_ok(frame, spec):
                self.stats["crc_errors"] += 1
                self.stats["bytes_discarded"] += 1
                pos += 1
                continue
            s, i = self._interpret(frame)
            samples += s
            info.update(i)
            pos += total
        self.buf = self.buf[pos:]
        return samples, info

    def _interpret(self, b: bytes):
        msg = next((m for m in self.d["messages"] if _matches(b, m.get("match"))), None)
        if msg is None:
            self.stats["malformed"] += 1
            return [], {}
        ts = None
        if "timestamp" in msg:
            t = msg["timestamp"]
            raw = read_num(b, t["offset"], t["type"])
            if raw is None:
                self.stats["malformed"] += 1
                return [], {}
            if t["type"].startswith("u"):
                state = self.epochs.setdefault(f'{t["offset"]}:{t["type"]}', [None, 0])
                span = 1 << (SIZES[t["type"]] * 8)
                if state[0] is not None and raw < state[0] and state[0] - raw > span // 2:
                    state[1] += span
                state[0] = raw
                raw += state[1]
            ts = raw * 1000 if t["unit"] == "ms" else raw
        seq = read_num(b, msg["seq"]["offset"], msg["seq"]["type"]) if "seq" in msg else None

        if msg.get("info"):
            info = {}
            for f in msg["fields"]:
                if f["kind"] == "hex":
                    info[f["channel"]] = b[f["offset"]:f["offset"] + f["length"]].hex()
                elif _matches(b, f.get("when")):
                    raw = read_num(b, f["offset"], f["type"])
                    if raw is not None:
                        info[f["channel"]] = _scaled(raw, f)
            self.stats["frames_ok"] += 1
            return [], info

        out = []
        for f in msg["fields"]:
            if f["kind"] == "scalar":
                if not _matches(b, f.get("when")):
                    continue
                raw = read_num(b, f["offset"], f["type"])
                if raw is None:
                    self.stats["malformed"] += 1
                    return [], {}
                out.append((f["channel"], _scaled(raw, f), f.get("unit"), ts, seq))
            elif f["kind"] == "samples":
                ref = lambda v: v if isinstance(v, (int, float)) else read_num(b, v["offset"], v["type"])  # noqa: E731
                count, period = ref(f["count"]), ref(f["periodUs"])
                for i in range(count or 0):
                    raw = read_num(b, f["offset"] + i * f["stride"], f["type"])
                    if raw is None:
                        self.stats["malformed"] += 1
                        return [], {}
                    out.append((f["channel"], _scaled(raw, f), f.get("unit"), None if ts is None else ts + i * period, seq))
        out.sort(key=lambda s: s[3] or 0)
        self.stats["frames_ok"] += 1
        return out, {}

    def _text(self, chunk: bytes):
        fmt = self.d["text"]
        self.buf += chunk
        *lines, self.buf = self.buf.split(self.d["framing"]["delimiter"].encode())
        out = []
        for line in lines:
            parts = [p.strip() for p in line.decode(errors="replace").strip().split(fmt["separator"])]
            if fmt["mode"] == "channel-value":
                try:
                    out.append((parts[0], float(parts[1]), self.units.get(parts[0]), None, None))
                except (IndexError, ValueError):
                    self.stats["malformed"] += 1
            else:
                for col in fmt["columns"]:
                    try:
                        out.append((col["channel"], _scaled(float(parts[col["index"]]), col), col.get("unit"), None, None))
                    except (IndexError, ValueError):
                        pass
        return out, {}


def load(path: str | Path):
    """Returns (rows, meta). meta['connections'][i]['info'] and ['stats'] are filled in after decoding."""
    lines = [l for l in Path(path).read_text().splitlines() if l.strip()]
    header = json.loads(lines[0])
    if header.get("format") != "biobridge.recording":
        raise ValueError("not a BioBridge recording")
    meta = header["meta"]
    conns = {c["key"]: c for c in meta["connections"]}
    decoders = {k: Decoder(c["descriptor"]) for k, c in conns.items()}
    rows = []
    for line in lines[1:]:
        r = json.loads(line)
        samples, info = decoders[r["c"]].push(base64.b64decode(r["b"]))
        if info:
            conns[r["c"]].setdefault("info", {}).update(info)
        for ch, value, unit, dev_us, seq in samples:
            rows.append({"conn": r["c"], "label": conns[r["c"]]["label"], "channel": ch, "value": value,
                         "unit": unit, "host_ms": r["t"], "device_us": dev_us, "seq": seq})
    for k, d in decoders.items():
        conns[k]["stats"] = d.stats
    return rows, meta


def selftest() -> int:
    root = Path(__file__).resolve().parent.parent
    vectors = json.loads((root / "protocol/test-vectors.json").read_text())
    lib = root / "app/src/descriptors/library"
    descs = {p.stem: json.loads(p.read_text()) for p in lib.glob("*.json")}
    assert crc16_ccitt_false(vectors["crc_check"]["ascii"].encode()) == vectors["crc_check"]["crc"]
    check = b"123456789"
    assert [CHECKSUMS[k][1](check) for k in ("crc16-modbus", "sum8", "xor8")] == [0x4B37, 0xDD, 0x31]
    decoders = {}
    for v in vectors["frames"]:
        dec = decoders.setdefault(v["descriptor"], Decoder(descs[v["descriptor"]]))
        samples, info = dec.push(bytes.fromhex(v["frame_hex"]))
        got = [{"channel": c, "value": val, "deviceTimestampUs": ts} for c, val, _, ts, _ in samples]
        assert got == v["expect"]["samples"], (v["name"], got)
        if "info" in v["expect"]:
            assert info == v["expect"]["info"], (v["name"], info)
    print(f"selftest ok: {len(vectors['frames'])} vectors")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("path", nargs="?")
    ap.add_argument("--csv", help="write all decoded rows to this CSV file")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.path:
        ap.error("path is required (or use --selftest)")

    rows, meta = load(args.path)
    dur = ((meta.get("endedAt") or meta["startedAt"]) - meta["startedAt"]) / 1000
    print(f'{meta["name"]}: {dur:.1f} s, {len(rows)} samples')
    for c in meta["connections"]:
        chans: dict[str, int] = {}
        for r in rows:
            if r["conn"] == c["key"]:
                chans[r["channel"]] = chans.get(r["channel"], 0) + 1
        print(f'  [{c["key"]}] {c["label"]} ({c["descriptor"]["id"]}): '
              + ", ".join(f"{k}={n}" for k, n in chans.items()))
        print(f'       stats {c["stats"]}  info {c.get("info", {})}')
        if c.get("groundTruth"):
            print(f'       ground truth {c["groundTruth"]}')

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["conn", "label", "channel", "value", "unit", "host_ms", "device_us", "seq"])
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {args.csv}")
    else:
        try:
            import pandas as pd
            print(pd.DataFrame(rows).head(12).to_string())
        except ImportError:
            for r in rows[:12]:
                print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
