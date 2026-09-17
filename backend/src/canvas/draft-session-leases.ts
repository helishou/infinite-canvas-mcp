export const CANVAS_DRAFT_LEASE_HEARTBEAT_MS = 15_000;
export const CANVAS_DRAFT_LEASE_TTL_MS = 30_000;

export type CanvasDraftLease = {
  owner: string;
  holderId: string;
  expiresAt: number;
};

export type CanvasDraftLeaseStatus = {
  active: boolean;
  owned: boolean;
  expiresAt: number | null;
};

/**
 * 普通 HTTP 页面没有 Web Locks；这里提供进程内租约作为局域网回退。
 * 租约只保护浏览器本机草稿归属，不属于画布业务数据，因此不落库、不增加 revision。
 */
export class CanvasDraftSessionLeases {
  private readonly leases = new Map<string, CanvasDraftLease>();

  constructor(private readonly now: () => number = Date.now) {}

  acquire(owner: string, holderId: string): CanvasDraftLeaseStatus {
    const current = this.current(owner);
    if (current && current.holderId !== holderId)
      return { active: true, owned: false, expiresAt: current.expiresAt };
    const lease = {
      owner,
      holderId,
      expiresAt: this.now() + CANVAS_DRAFT_LEASE_TTL_MS,
    };
    this.leases.set(owner, lease);
    return { active: true, owned: true, expiresAt: lease.expiresAt };
  }

  status(owner: string, holderId?: string): CanvasDraftLeaseStatus {
    const current = this.current(owner);
    return current
      ? {
          active: true,
          owned: Boolean(holderId) && current.holderId === holderId,
          expiresAt: current.expiresAt,
        }
      : { active: false, owned: false, expiresAt: null };
  }

  release(owner: string, holderId: string) {
    const current = this.current(owner);
    if (!current || current.holderId !== holderId) return false;
    this.leases.delete(owner);
    return true;
  }

  private current(owner: string) {
    const lease = this.leases.get(owner);
    if (!lease) return null;
    if (lease.expiresAt > this.now()) return lease;
    this.leases.delete(owner);
    return null;
  }
}
