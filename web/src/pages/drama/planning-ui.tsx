import { Input } from "antd";
import { useState, type ReactNode } from "react";

/**
 * 剧目策划几块内容共用的视觉件：
 * 统一的分区卡（标题 / 说明 / 右侧操作）、标签、chip、字段。
 * 只负责外观，不碰数据与逻辑。
 */

export function PlanningSection({ title, hint, actions, children, part }: {
    title: string;
    hint?: string;
    actions?: ReactNode;
    children: ReactNode;
    part?: string;
}) {
    return <section className="overflow-hidden rounded-xl border border-border/80 bg-card/50" {...(part ? { "data-outline-part": part } : {})}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-4 py-2.5">
            <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
            {hint ? <p className="min-w-0 flex-1 truncate text-[11px] text-foreground/55">{hint}</p> : <span className="min-w-0 flex-1" />}
            {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
        <div className="space-y-3 px-4 py-3.5">{children}</div>
    </section>;
}

export function PlanningChip({ active, onClick, children, group, numeric }: {
    active: boolean;
    onClick: () => void;
    children: ReactNode;
    group?: string;
    numeric?: boolean;
}) {
    return <button type="button" aria-pressed={active} onClick={onClick} data-chip-group={group}
        className={`h-7 shrink-0 rounded-full px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${numeric ? "tabular-nums" : ""} ${active
            ? "bg-primary font-semibold text-primary-foreground shadow-sm"
            : "bg-transparent text-foreground/70 ring-1 ring-inset ring-border hover:bg-muted/70 hover:text-foreground"}`}>{children}</button>;
}

export function PlanningField({ label, hint, children, action }: { label: string; hint?: string; children: ReactNode; action?: ReactNode }) {
    return <div className="block">
        <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {action}
            {hint ? <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">{hint}</span> : null}
        </div>
        {children}
    </div>;
}

/** 一行里并排放两组 chip 时用：左边固定标签，右边自动换行。 */
export function PlanningChipRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
    return <div className="flex items-start gap-3">
        <span className="w-14 shrink-0 pt-1 text-xs text-foreground/60">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}{hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}</div>
    </div>;
}

export function PlanningEmpty({ text, action }: { text: string; action?: ReactNode }) {
    return <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border/80 bg-muted/[0.08] px-5 py-8">
        <p className="text-sm text-muted-foreground">{text}</p>
        {action}
    </div>;
}

/** 每块内容最上面的操作条：模型选择 + 交给导演 + 主操作，右对齐，不跟正文混在一起。 */
export function PlanningToolbar({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/[0.12] px-3 py-2">{children}</div>;
}

/** 导演大师每个字段右侧都有「输入…回车添加」：规划页沿用同一入口，别只在新建向导里有。 */
export function ChipAdder({ placeholder, onAdd }: { placeholder: string; onAdd: (value: string) => void }) {
    const [draft, setDraft] = useState("");
    const commit = () => {
        const value = draft.trim();
        if (!value) return;
        onAdd(value);
        setDraft("");
    };
    return <Input size="small" className="w-40" allowClear value={draft} placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)} onPressEnter={commit} />;
}
