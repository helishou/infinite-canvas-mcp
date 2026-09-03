/**
 * 复刻 CPython `_random.Random(seed)`（CPython Modules/_randommodule.c）。
 * CPython 对 int seed 用 `init_by_array(key, keyused)`（不是 init_genrand）。
 * 用法：`new Random(1337).nextInt(6)` 严格等于 Python `random.Random(1337).randrange(6)`。
 */
export class Random {
    private state: Uint32Array;
    private index: number;

    constructor(seed: number) {
        this.state = new Uint32Array(624);
        this.index = 624; // init 后 position=624（N）；C 的 self->index=mti=624
        // key = seed 的 32-bit 小端数组（单个 uint32）
        const key = [seed & 0xffffffff];
        const keyLen = 1;
        const mt = this.state;
        // init_genrand(19650218U)
        this.initGenrand(19650218);
        // MT 是 624 槽；i 在 1..624 循环用 mod 语义
        let i = 1, j = 0;
        let k = 624 > keyLen ? 624 : keyLen; // 624
        for (; k > 0; k--) {
            const x = (mt[i - 1] ^ (mt[i - 1] >>> 30)) >>> 0;
            mt[i] = ((mt[i] ^ Number((BigInt(x) * 1664525n & 0xffffffffn))) + key[j % keyLen] + j) >>> 0;
            i++; j++;
            if (i >= 624) { mt[0] = mt[623]; i = 1; }
            if (j >= keyLen) j = 0;
        }
        for (k = 623; k > 0; k--) {
            const x = (mt[i - 1] ^ (mt[i - 1] >>> 30)) >>> 0;
            mt[i] = ((mt[i] ^ Number((BigInt(x) * 1566083941n & 0xffffffffn))) - i) >>> 0;
            i++;
            if (i >= 624) { mt[0] = mt[623]; i = 1; }
        }
        mt[0] = 0x80000000; // MSB 置 1，保证非零初始数组
    }

    private initGenrand(s: number): void {
        const mt = this.state;
        mt[0] = s >>> 0;
        for (let mti = 1; mti < 624; mti++) {
            const x = (mt[mti - 1] ^ (mt[mti - 1] >>> 30)) >>> 0;
            mt[mti] = Number(((BigInt(x) * 1812433253n + BigInt(mti)) & 0xffffffffn)) >>> 0;
        }
        this.index = 624;
    }

    /** 返回 [0, n) 的整数，严格复刻 CPython `_random._randbelow(n)`（拒绝抽样）。
     * CPython `randrange(6)` 走 `_randbelow(6)`：`k=n.bitLength()`，
     * `while (r=getrandbits(k)) >= n 重抽；return r`。n 必须 < 2^32。 */
    nextInt(n: number): number {
        let k = 0;
        while ((n >> k) > 0) k++;   // bit_length
        for (;;) {
            const r = this.getrandbits(k);
            if (r < n) return r;
        }
    }

    /** 严格复刻 CPython `getrandbits(k)`，k 位无符号。k≤32 直接取字高 k 位；
     * 更大的 k 逐字拼接（本任务只用 k=3，通用到任意 k）。 */
    private getrandbits(k: number): number {
        if (k <= 1) return this.next32() >>> 0 & (k ? 1 : 0);
        if (k <= 32) return this.next32() >>> (32 - k);
        // k>32：高字保留 k-32 位，剩余补足
        let result = this.getrandbits(k - 32);
        // 取 k-32 位的低部分 + 一个完整字移位
        const rest = Math.min(32, k - 32);
        return (result << rest) | (this.next32() >>> (32 - rest));
    }

    private next32(): number {
        if (this.index >= 624) this.twist();
        let y = this.state[this.index++];
        y ^= y >>> 11;
        y ^= (y << 7) & 0x9d2c5680;
        y ^= (y << 15) & 0xefc60000;
        y ^= y >>> 18;
        return y >>> 0;
    }

    private twist(): void {
        const s = this.state;
        for (let i = 0; i < 624; i++) {
            const x = (s[i] & 0x80000000) | (s[(i + 1) % 624] & 0x7fffffff);
            const upper = x >>> 1;
            s[i] = (s[(i + 397) % 624] ^ upper ^ (x & 1 ? 0x9908b0df : 0)) >>> 0;
        }
        this.index = 0;
    }
}
