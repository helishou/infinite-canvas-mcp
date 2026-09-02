/**
 * MT19937（Mersenne Twister 19937）复刻 Python `random.Random(seed)`。
 * 用法：`new Random(1337).nextInt(6)` 对应 Python `random.Random(1337).randrange(6)`。
 *
 * Python 的 `random.seed(a)` 对 int a 执行 `_random.Random(a)`：直接 a 当 MT 状态。
 * 这里逐字节对齐 CPython `random.c` 的 `mersenne_twister`：
 *   - s[0] = seed & 0xffffffff
 *   - for i in 1..623: s[i] = (1812433253 * (s[i-1] ^ (s[i-1] >> 30)) + i) & 0xffffffff
 */
export class Random {
    private state: Uint32Array;
    private index: number;

    constructor(seed: number) {
        this.state = new Uint32Array(624);
        this.index = 0; // Python random.Random(seed): 直接从 state[0] 开始消费，twist 在消费完 624 个后才做
        let s = seed & 0xffffffff;
        this.state[0] = s;
        for (let i = 1; i < 624; i++) {
            const prev = this.state[i - 1];
            const x = (prev ^ (prev >>> 30)) >>> 0;
            // 1812433253 * x + i (mod 2^32)。x 最大 0xffffff（< 2^29），乘积 < 2^60，
            // 安全用 Number（< 2^53）。
            this.state[i] = (1812433253 * x + i) >>> 0;
        }
    }

    /** 返回 [0, n) 的整数。n <= 2^53（等价 Python `randrange(n)`，内部 53-bit）。 */
    nextInt(n: number): number {
        // CPython random() = getrandbits(53)/2^53 = (hi27 << 26) | lo27。
        // 取两次 32-bit word，各砍高位 27，拼成 53 位再归一化。
        const a = this.next32(); // [0, 2^32)
        const b = this.next32();
        // CPython random() = ( (a & (2^27-1)) * 2^26 + (b & (2^27-1)) ) / 2^53
        const hi = a & 0x7ffffff;      // 27 位（0 .. 2^27-1）
        const lo = b & 0x7ffffff;      // 27 位
        const n53 = hi * 0x4000000 + lo;            // 0x4000000 = 2^26；hi*2^26 + lo < 2^53
        return Math.floor((n53 / 0x2000000000000) * n); // 0x2000000000000 = 2^53
    }

    /** 单次 32-bit word（MT19937 一个 output）。 */
    private next32(): number {
        if (this.index >= 624) this.twist();
        let y = this.state[this.index++];
        y ^= y >>> 11;
        y ^= (y << 7) & 0x9d2c5680;
        y ^= (y << 15) & 0xefc60000;
        y ^= y >>> 18;
        return y >>> 0; // >>>0 保证无符号 [0, 2^32)；不要再 & 0xffffffff（会变回有符号）
    }

    private twist(): void {
        const s = this.state;
        for (let i = 0; i < 624; i++) {
            const x = (s[i] & 0x80000000) | (s[(i + 1) % 624] & 0x7fffffff);
            // s[i+397] ^ (x>>1) ^ (mag[x&1] * (x>>1))
            const right = x >>> 1;
            s[i] = (s[(i + 397) % 624] ^ right ^ (x & 1 ? 0x9908b0df : 0)) >>> 0;
        }
        this.index = 0;
    }
}
