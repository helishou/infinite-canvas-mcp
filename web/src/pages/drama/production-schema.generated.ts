// 由 schema/production.schema.json 生成，勿手改。
export const SCHEMA_VERSION = 3;
export const MAX_CHARS_PER_TEXT_ITEM = 7000;

export const FACTS_FIELDS = ["orientation","ground","axis","framing","movement","dof"] as const;
export const COMBAT_FIELDS = ["axis","distance","contact","damage","tail"] as const;
export const PERFORMANCE_FIELDS = ["axis","eyeline","distance","state_change"] as const;

export interface FieldDescriptor { key: string; label: string; max: number; hint: string }

export const FACTS_FIELD_DESCRIPTORS: FieldDescriptor[] = [{"key":"orientation","label":"人物朝向","max":90,"hint":"他面向画面右，她面向画面左"},{"key":"ground","label":"地面与道具状态","max":90,"hint":"干爽青石，红绸平铺，只有击打线有水"},{"key":"axis","label":"轴线与机位关系","max":120,"hint":"他在画面左、她在画面右，机位不越轴"},{"key":"framing","label":"景别与焦段","max":80,"hint":"中景，胸高，35mm"},{"key":"movement","label":"运镜","max":80,"hint":"横移跟拍，镜内不切"},{"key":"dof","label":"景深","max":70,"hint":"两人清楚，背景桌面虚"}];
export const COMBAT_FIELD_DESCRIPTORS: FieldDescriptor[] = [{"key":"axis","label":"轴线保持","max":80,"hint":"他在画面左、她在画面右，机位不越轴"},{"key":"distance","label":"起止间距（米）","max":40,"hint":"3.0 米 → 2.2 米"},{"key":"contact","label":"接触点","max":60,"hint":"剑刃压在她右肩外的鞭梢上"},{"key":"damage","label":"伤害与损耗","max":60,"hint":"绸缎炸成水雾，双方无伤"},{"key":"tail","label":"尾帧状态","max":60,"hint":"水雾未落，他的剑还在下劈"}];
export const PERFORMANCE_FIELD_DESCRIPTORS: FieldDescriptor[] = [{"key":"axis","label":"轴线保持","max":80,"hint":"他在画面左、她在画面右，机位不越轴"},{"key":"eyeline","label":"视线关系","max":60,"hint":"她的视线钉在他脸上，他抬眼迎住"},{"key":"distance","label":"人物间距","max":40,"hint":"3.0 米 → 2.2 米"},{"key":"state_change","label":"状态变化","max":80,"hint":"他把钥匙递出去，拇指松了劲"}];

export interface ShotFactsContract {
  orientation?: string;
  ground?: string;
  axis?: string;
  framing?: string;
  movement?: string;
  dof?: string;
}

export interface CombatContract {
  axis?: string;
  distance?: string;
  contact?: string;
  damage?: string;
  tail?: string;
}

export interface PerformanceContract {
  axis?: string;
  eyeline?: string;
  distance?: string;
  stateChange?: string;
}


export const GUIDANCE = {
  "note": "写作方法，供 agent 写正文时遵循；不参与校验、不参与编译、不进 schema 字段。",
  "combat_beats": [
    "approach",
    "commit",
    "contact",
    "recovery",
    "reset"
  ],
  "combat_layers": [
    "force_source",
    "trajectory",
    "contact",
    "resistance",
    "impact_hold",
    "transfer",
    "recoil"
  ],
  "performance_beats": [
    "open",
    "press",
    "turn",
    "land",
    "after"
  ],
  "see": [
    "references/40-action-choreography.md",
    "references/31-performance-handoff.md"
  ]
} as const;
