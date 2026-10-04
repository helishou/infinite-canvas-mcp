export type WorkflowFieldType = 'text' | 'number' | 'slider' | 'boolean' | 'dropdown' | 'image' | 'audio' | 'video';

/** RunningHub 的值来源：constant=运行时填写，其余表示由提示词/素材/H3 参数注入。 */
export type WorkflowFieldSource = 'constant' | 'prompt' | 'image' | 'video' | 'audio' | 'param';

/**
 * 字段模型只有这一份，本地 ComfyUI 与 RunningHub 共用。
 * rh* 是 RunningHub 映射需要的附加语义；本地 ComfyUI 不使用这些字段，
 * 但它们让两种来源共用同一个字段编辑器，而不是各写一套。
 */
export type WorkflowField = {
    id: string;
    node: string;
    input: string;
    name: string;
    type: WorkflowFieldType;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    randomEnabled?: boolean;
    isPrompt?: boolean;
    /** 留空必填；RunningHub 映射用它拒绝空值提交。 */
    required?: boolean;
    /** RunningHub 值来源。undefined 表示本地 ComfyUI 字段（不显示来源控件）。 */
    rhSource?: WorkflowFieldSource;
    /** rhSource=param 时的 H3 参数名。 */
    rhParamKey?: string;
    /** 素材字段的序号（1 起）。 */
    rhIndex?: number;
};

export type WorkflowConfig = {
    title: string;
    backend: string;
    operation: string;
    description: string;
    fields: WorkflowField[];
    /**
     * 指定输出节点：只保留这些节点的产物。
     * 留空表示不过滤，沿用工作流全部输出。节点 ID 用工作流自身编号。
     */
    outputNodes?: string[];
    mediaInputs?: Record<string, unknown>;
    miniCards?: Record<string, unknown>;
};
