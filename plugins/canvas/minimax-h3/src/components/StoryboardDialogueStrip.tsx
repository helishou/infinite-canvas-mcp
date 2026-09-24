import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { extractDialogues } from "../services/storyboard-dialogue";

export type StoryboardSpeakerOption = { id: string; name?: string; previewUrl?: string };

type Props = {
  /** 分镜描述（干净文本，不含 (Sx)） */
  description: string;
  /** 按台词顺序的说话人绑定，如 ["S1", "", "S2"] */
  dialogueSpeakers?: string[];
  /** 可选说话人（当前 Clip 的角色 + 已确立的 Sx 编号），为空时退回 S1–S6 */
  speakers?: StoryboardSpeakerOption[];
  /** 绑定/解绑某条台词 */
  onBind: (index: number, speaker: string | null) => void;
};

const FALLBACK_SPEAKER_COUNT = 6;

export function StoryboardDialogueStrip({ description, dialogueSpeakers, speakers, onBind }: Props) {
  const dialogues = extractDialogues(description);
  if (!dialogues.length) return null;
  const roster: StoryboardSpeakerOption[] = speakers?.length
    ? speakers
    : Array.from({ length: FALLBACK_SPEAKER_COUNT }, (_, i) => ({ id: `S${i + 1}` }));
  const nameFor = (id: string | null) => (id ? roster.find((option) => option.id === id)?.name : undefined);
  const items: MenuProps["items"] = [
    ...roster.map((option) => ({
      key: option.id,
      label: (
        <span className="nfh3-speaker-option">
          {option.previewUrl ? <img src={option.previewUrl} alt="" /> : null}
          <span>{option.name ? `${option.id} · ${option.name}` : option.id}</span>
        </span>
      ),
    })),
    { type: "divider" },
    { key: "clear", label: "清除绑定" },
  ];
  return (
    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, opacity: 0.6, marginRight: 2 }}>台词绑定 · 点击台词绑定说话人</span>
      {dialogues.map((dlg, i) => {
        const speaker = dialogueSpeakers?.[i] || dlg.speaker || null;
        const speakerName = nameFor(speaker);
        const preview = dlg.preview.length > 48 ? `${dlg.preview.slice(0, 48)}…` : dlg.preview;
        return (
          <Dropdown
            key={i}
            trigger={["click"]}
            menu={{
              items,
              onClick: ({ key }) => onBind(i, key === "clear" ? null : key),
            }}
          >
            <button
              type="button"
              title="点击绑定说话人"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                maxWidth: 360,
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid rgba(120,120,255,0.5)",
                background: "rgba(120,120,255,0.16)",
                color: "inherit",
                font: "inherit",
                fontSize: 13,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                “{preview}”
              </span>
              <span
                style={{
                  flex: "0 0 auto",
                  padding: "0 6px",
                  borderRadius: 4,
                  fontSize: 11,
                  lineHeight: "16px",
                  background: speaker ? "rgba(34,197,94,0.28)" : "rgba(255,255,255,0.12)",
                  border: `1px solid ${speaker ? "rgba(34,197,94,0.6)" : "rgba(255,255,255,0.25)"}`,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 140,
                }}
              >
                {speaker ? speakerName || speaker : "未绑定"}
              </span>
            </button>
          </Dropdown>
        );
      })}
    </div>
  );
}
