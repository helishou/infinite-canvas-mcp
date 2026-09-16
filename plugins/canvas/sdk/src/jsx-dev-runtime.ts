// automatic JSX 的 dev 变体(编译器在 dev 模式会引用 jsxDEV)。转发到同一套 createElement。

import type * as React from "react";

import { getReact } from "./runtime";
import { Fragment } from "./jsx-runtime";

export { Fragment };
export type { JSX } from "./jsx-runtime";

export function jsxDEV(type: unknown, props: Record<string, unknown> | null, key?: unknown, isStaticChildren = false): React.ReactElement {
    const react = getReact();
    const resolvedType = type === Fragment ? react.Fragment : type;
    if (isStaticChildren && Array.isArray(props?.children)) {
        const { children, ...rest } = props;
        const config = key === undefined ? rest : { ...rest, key };
        return react.createElement(resolvedType as never, config as never, ...children as React.ReactNode[]) as React.ReactElement;
    }
    const config = key === undefined ? props : { ...(props ?? {}), key };
    return react.createElement(resolvedType as never, config as never);
}
