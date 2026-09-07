import { useState, useRef, useCallback, useEffect } from "react";
import { Modal } from "antd";

interface ImageCompareModalProps {
  open: boolean;
  beforeUrl: string | null;
  afterUrl: string;
  title?: string;
  onClose: () => void;
}

export function ImageCompareModal({ open, beforeUrl, afterUrl, title, onClose }: ImageCompareModalProps) {
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const updateSliderPos = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPos(pct);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    updateSliderPos(e.clientX);
  }, [updateSliderPos]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    isDragging.current = true;
    updateSliderPos(e.touches[0].clientX);
  }, [updateSliderPos]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    e.preventDefault();
    updateSliderPos(e.clientX);
  }, [updateSliderPos]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging.current) return;
    updateSliderPos(e.touches[0].clientX);
  }, [updateSliderPos]);

  const handleEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  useEffect(() => {
    if (open) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleEnd);
      window.addEventListener("touchmove", handleTouchMove);
      window.addEventListener("touchend", handleEnd);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleEnd);
        window.removeEventListener("touchmove", handleTouchMove);
        window.removeEventListener("touchend", handleEnd);
      };
    }
  }, [open, handleMouseMove, handleTouchMove, handleEnd]);

  useEffect(() => {
    if (open) setSliderPos(50);
  }, [open]);

  return (
    <Modal
      title={title}
      open={open}
      centered
      onCancel={onClose}
      footer={null}
      width="auto"
      styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
    >
      {beforeUrl ? (
        <div
          ref={containerRef}
          style={{ position: "relative", maxWidth: "92vw", maxHeight: "80vh", overflow: "hidden", cursor: "ew-resize", userSelect: "none" }}
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
        >
          <img src={afterUrl} alt={title} style={{ display: "block", maxWidth: "92vw", maxHeight: "80vh", objectFit: "contain", pointerEvents: "none" }} />
          <div style={{ position: "absolute", inset: 0, overflow: "hidden", width: `${sliderPos}%`, pointerEvents: "none" }}>
            <img src={beforeUrl} alt={`${title} (before)`} style={{ display: "block", maxWidth: "92vw", maxHeight: "80vh", objectFit: "contain", pointerEvents: "none" }} />
          </div>
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sliderPos}%`, width: 2, background: "#fff", boxShadow: "0 0 6px rgba(0,0,0,0.5)", transform: "translateX(-50%)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: "50%", left: `${sliderPos}%`, width: 28, height: 28, borderRadius: "50%", background: "#fff", boxShadow: "0 0 6px rgba(0,0,0,0.5)", transform: "translate(-50%, -50%)", pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 3L2 8L5 13" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M11 3L14 8L11 13" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <div style={{ position: "absolute", top: 12, left: 12, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 12, pointerEvents: "none" }}>Before</div>
          <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 12, pointerEvents: "none" }}>After</div>
        </div>
      ) : (
        <img src={afterUrl} alt={title} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
      )}
    </Modal>
  );
}
