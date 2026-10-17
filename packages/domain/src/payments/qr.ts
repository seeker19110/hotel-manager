// Bộ mã hoá QR (ISO/IEC 18004) tối thiểu cho chuỗi VietQR: chế độ byte, mức sửa lỗi M, phiên bản 1–10 (tối đa 213 byte).
// Thuần tính toán, không I/O — trả ma trận module; hiển thị (SVG) ở lớp web. Chỉ dùng để HIỂN THỊ thông tin chuyển tiền
// (SPEC-ledger S-015) — người thuê vẫn phải bấm "Tôi đã chuyển", QR không xác nhận thu (INV-F3).

/** Mức M: [mã dữ liệu mỗi nhóm khối: (số khối, mã dữ liệu/khối)[], mã sửa lỗi/khối]. Tổng dữ liệu khớp bảng 9 của chuẩn. */
const BLOCKS_M: readonly { groups: readonly [number, number][]; ec: number }[] = [
  { groups: [[1, 16]], ec: 10 },
  { groups: [[1, 28]], ec: 16 },
  { groups: [[1, 44]], ec: 26 },
  { groups: [[2, 32]], ec: 18 },
  { groups: [[2, 43]], ec: 24 },
  { groups: [[4, 27]], ec: 16 },
  { groups: [[4, 31]], ec: 18 },
  {
    groups: [
      [2, 38],
      [2, 39],
    ],
    ec: 22,
  },
  {
    groups: [
      [3, 36],
      [2, 37],
    ],
    ec: 22,
  },
  {
    groups: [
      [4, 43],
      [1, 44],
    ],
    ec: 26,
  },
];
const ALIGN: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];
export const QR_MAX_BYTES = 213;

// GF(256) với đa thức 0x11D.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}
const gmul = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);

/** Phần dư Reed–Solomon của `data` chia đa thức sinh bậc `degree`. */
function rsRemainder(data: readonly number[], degree: number): number[] {
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] as number) ^ gmul(gen[j] as number, EXP[i] as number);
      next[j + 1] = (next[j + 1] as number) ^ (gen[j] as number);
    }
    gen = next;
  }
  // gen: hệ số từ bậc thấp → cao của ∏(x − α^i), đầu mảng là hệ số tự do; đa thức monic.
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    for (let i = 0; i < degree; i++)
      rem[i] = (rem[i] as number) ^ gmul(gen[degree - 1 - i] as number, factor);
  }
  return rem;
}

const bit = (v: number, i: number) => ((v >>> i) & 1) === 1;

function dataCodewords(bytes: Uint8Array, version: number, capacity: number): number[] {
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const spec = BLOCKS_M[version - 1] as (typeof BLOCKS_M)[number];
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of spec.groups)
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  const ecs = blocks.map((b) => rsRemainder(b, spec.ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  for (let i = 0; i < spec.ec; i++) for (const e of ecs) out.push(e[i] as number);
  return out;
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  for (const rows of [m, m[0]?.map((_, x) => m.map((r) => r[x] as boolean)) as boolean[][]]) {
    for (const row of rows) {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && row[i] === row[i - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // Mẫu giống dấu định vị 1:1:3:1:1 kèm 4 ô sáng một bên.
      for (let i = 0; i + 11 <= n; i++) {
        const w = row
          .slice(i, i + 11)
          .map((v) => (v ? "1" : "0"))
          .join("");
        if (w === "10111010000" || w === "00001011101") score += 40;
      }
    }
  }
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = m[y]?.[x];
      if (c === m[y]?.[x + 1] && c === m[y + 1]?.[x] && c === m[y + 1]?.[x + 1]) score += 3;
    }
  const dark = m.flat().filter(Boolean).length;
  score += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
  return score;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Ma trận module QR (true = tối), `m[hàng][cột]`. Chuỗi > 213 byte UTF-8 → RangeError. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) throw new RangeError("Chuỗi QR rỗng");
  const version = (() => {
    for (let v = 1; v <= BLOCKS_M.length; v++) {
      const spec = BLOCKS_M[v - 1] as (typeof BLOCKS_M)[number];
      const cap = spec.groups.reduce((s, [c, n]) => s + c * n, 0);
      if (4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= cap * 8) return v;
    }
    throw new RangeError(`Chuỗi QR dài quá ${QR_MAX_BYTES} byte`);
  })();
  const spec = BLOCKS_M[version - 1] as (typeof BLOCKS_M)[number];
  const capacity = spec.groups.reduce((s, [c, n]) => s + c * n, 0);
  const codewords = interleave(dataCodewords(bytes, version, capacity), version);

  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    (modules[y] as boolean[])[x] = dark;
    (fn[y] as boolean[])[x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, d !== 2 && d !== 4);
      }
  const pos = ALIGN[version - 1] as readonly number[];
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0))
        continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn((pos[i] as number) + dx, (pos[j] as number) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask: number) => {
    const data = (0b00 << 3) | mask; // mức M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6));
    setFn(8, 8, bit(bits, 7));
    setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // đặt chỗ vùng định dạng trước khi rải dữ liệu
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i));
      setFn(b, a, bit(bits, i));
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!(fn[y] as boolean[])[x] && i < codewords.length * 8) {
          (modules[y] as boolean[])[x] = bit(codewords[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
  }

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const cand = modules.map((row, y) =>
      row.map(
        (v, x) =>
          v !== (!(fn[y] as boolean[])[x] && (MASKS[mask] as (x: number, y: number) => boolean)(x, y)),
      ),
    );
    // Vùng định dạng của mặt nạ này
    const saved = modules.map((r) => r.slice());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) (modules[y] as boolean[])[x] = (cand[y] as boolean[])[x] as boolean;
    drawFormat(mask);
    const withFormat = modules.map((r) => r.slice());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) (modules[y] as boolean[])[x] = (saved[y] as boolean[])[x] as boolean;
    const s = penalty(withFormat);
    if (s < bestScore) {
      bestScore = s;
      best = withFormat;
    }
  }
  return best as boolean[][];
}
