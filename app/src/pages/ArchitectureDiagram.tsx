import type { ConnectionView } from "../session/sessionManager";

// The system as blocks, lit from the actual session: a block is "on" when something real flows through it
// right now (a connected device, a measured sync pair, an active recording), "warn" on an error.

type State = "on" | "off" | "warn";
type Block = { id: string; col: number; row: number; label: string; sub: string; state: State };

const COLS = [
  { x: 10, title: "SENSORS" },
  { x: 205, title: "DEVICES" },
  { x: 400, title: "LINK" },
  { x: 575, title: "GATEWAY (THIS BROWSER)" },
  { x: 790, title: "ANALYSIS & VIEWS" },
];
const W = [160, 165, 140, 180, 175];
const H = 46;
const rowY = (r: number) => 30 + r * 70;

export function ArchitectureDiagram({
  conns,
  syncPairs,
  recording,
  dspLoaded,
}: {
  conns: ConnectionView[];
  syncPairs: number;
  recording: boolean;
  dspLoaded: boolean;
}) {
  const live = conns.filter((c) => c.status === "connected");
  const errored = conns.some((c) => c.status === "error");
  const nodeA = live.filter((c) => ["node-a", "sim-node-a"].includes(c.factoryId));
  const nodeB = live.filter((c) => ["node-b", "sim-node-b"].includes(c.factoryId));
  const syncNode = live.filter((c) => c.factoryId === "sync-node");
  const others = live.filter((c) => !nodeA.includes(c) && !nodeB.includes(c) && !syncNode.includes(c));
  const serial = live.filter((c) => c.descriptor.transport.kind === "serial");
  const ble = live.filter((c) => c.descriptor.transport.kind === "ble");
  const desc = (cs: ConnectionView[]) => {
    if (cs.length === 0) return "not connected";
    const kinds = [...new Set(cs.map((c) => c.source))];
    return `${cs.length} live · ${kinds.join(" + ")}`;
  };
  const on = (b: boolean): State => (b ? "on" : "off");
  const verifyWarn = live.some((c) => c.verification.verdict === "failed" || c.verification.verdict === "suspect");

  const blocks: Block[] = [
    { id: "ecg", col: 0, row: 0, label: "ECG electrodes", sub: "AD8232 front end", state: on(nodeA.length > 0) },
    { id: "ppg", col: 0, row: 1, label: "PPG optical sensor", sub: "MAX30102 red / IR", state: on(nodeB.length > 0) },
    { id: "pulse", col: 0, row: 2, label: "Sync pulse rig", sub: syncPairs ? "edges observed" : "no edges observed", state: on(syncPairs > 0) },
    { id: "a", col: 1, row: 0, label: "Node A · ECG", sub: desc(nodeA), state: on(nodeA.length > 0) },
    { id: "b", col: 1, row: 1, label: "Node B · PPG", sub: desc(nodeB), state: on(nodeB.length > 0) },
    { id: "s", col: 1, row: 2, label: "Sync node", sub: desc(syncNode), state: on(syncNode.length > 0) },
    { id: "o", col: 1, row: 3, label: "Other devices", sub: desc(others), state: on(others.length > 0) },
    { id: "usb", col: 2, row: 0.5, label: "USB-serial", sub: serial.length ? `${serial.length} stream${serial.length > 1 ? "s" : ""}` : "idle", state: on(serial.length > 0) },
    { id: "ble", col: 2, row: 2, label: "Bluetooth LE", sub: ble.length ? `${ble.length} stream${ble.length > 1 ? "s" : ""}` : "idle", state: on(ble.length > 0) },
    { id: "dec", col: 3, row: 0, label: "Descriptor decoder", sub: "framing → messages → channels", state: errored ? "warn" : on(live.length > 0) },
    { id: "clk", col: 3, row: 1, label: "Clock mapping", sub: "device time → host time", state: on(live.length > 0) },
    { id: "ver", col: 3, row: 2, label: "Verifier", sub: "4 oracles, continuous", state: verifyWarn ? "warn" : on(live.length > 0) },
    { id: "rec", col: 3, row: 3, label: "Recorder", sub: recording ? "recording raw bytes" : "idle", state: on(recording) },
    { id: "dsp", col: 4, row: 0, label: "Signal processing", sub: dspLoaded ? "bbdsp (Wasm) + modules" : "Wasm loading", state: on(live.length > 0 && dspLoaded) },
    { id: "views", col: 4, row: 1, label: "Live data & alerts", sub: "waveforms, vitals", state: on(live.length > 0) },
    { id: "sync", col: 4, row: 2, label: "Sync error", sub: syncPairs ? `${syncPairs} pair${syncPairs > 1 ? "s" : ""} measured` : "needs two synced devices", state: on(syncPairs > 0) },
    { id: "store", col: 4, row: 3, label: "Recordings", sub: "IndexedDB · replay · export", state: on(recording) },
  ];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const links: [string, string][] = [
    ["ecg", "a"],
    ["ppg", "b"],
    ["pulse", "s"],
    ["a", "usb"],
    ["s", "usb"],
    ["b", "ble"],
    ["o", "usb"],
    ["o", "ble"],
    ["usb", "dec"],
    ["ble", "dec"],
    ["dec", "clk"],
    ["dec", "ver"],
    ["usb", "rec"],
    ["ble", "rec"],
    ["clk", "dsp"],
    ["clk", "views"],
    ["clk", "sync"],
    ["rec", "store"],
  ];

  const box = (b: Block) => ({ x: COLS[b.col].x, y: rowY(b.row), w: W[b.col] });
  const otherKinds = new Set(others.map((c) => c.descriptor.transport.kind));
  const linkOn = (a: Block, b: Block) => {
    if (a.id === "o" && (b.id === "usb" || b.id === "ble")) return otherKinds.has(b.id === "usb" ? "serial" : "ble");
    return a.state !== "off" && b.state !== "off";
  };

  return (
    <div className="arch">
      <svg viewBox="0 0 980 300" role="img" aria-label="System architecture; highlighted blocks are active in this session">
        {COLS.map((c) => (
          <text key={c.title} className="col-title" x={c.x} y={14}>
            {c.title}
          </text>
        ))}
        {links.map(([f, t]) => {
          const a = byId.get(f)!;
          const b = byId.get(t)!;
          const A = box(a);
          const B = box(b);
          const x1 = A.x + A.w;
          const y1 = A.y + H / 2;
          const x2 = B.x;
          const y2 = B.y + H / 2;
          const sameCol = a.col === b.col;
          const d = sameCol
            ? `M${A.x + A.w / 2},${A.y + H} L${B.x + B.w / 2},${B.y}`
            : `M${x1},${y1} C${x1 + 18},${y1} ${x2 - 18},${y2} ${x2},${y2}`;
          return <path key={`${f}-${t}`} d={d} className={linkOn(a, b) ? "lnk on" : "lnk"} markerEnd="url(#arrow)" />;
        })}
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {blocks.map((b) => {
          const { x, y, w } = box(b);
          return (
            <g key={b.id} className={`blk ${b.state === "off" ? "" : b.state}`}>
              <rect x={x} y={y} width={w} height={H} rx={4} />
              <text x={x + 10} y={y + 19} fontWeight={600}>
                {b.state === "on" ? "● " : b.state === "warn" ? "▲ " : "○ "}
                {b.label}
              </text>
              <text className="sub" x={x + 10} y={y + 35}>
                {b.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
