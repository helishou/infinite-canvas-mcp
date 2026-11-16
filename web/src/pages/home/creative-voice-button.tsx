import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { App, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { fetchAudioTranscribeStatus, transcribeAudioClip } from "@/services/backend-api";
import { resolveVoiceChannel } from "./creative-voice-channel";

type RecognitionResult = { 0?: { transcript?: string } };
type RecognitionEvent = { results?: ArrayLike<RecognitionResult> };
type Recognition = {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: RecognitionEvent) => void) | null;
    onerror: (() => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
};
type RecognitionConstructor = new () => Recognition;

function speechRecognition(): RecognitionConstructor | null {
    if (typeof window === "undefined") return null;
    const scope = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

type VoicePhase = "idle" | "recording" | "transcribing" | "listening";

/**
 * Voice input with a real Backend ASR channel: MediaRecorder clip -> /agent/audio-transcribe
 * (local Whisper) -> transcript appended to the composer. Browser Web Speech remains a fallback
 * for deployments without the Whisper runtime; when neither exists the button is disabled.
 */
export function CreativeVoiceButton({ disabled, onTranscribed }: { disabled?: boolean; onTranscribed: (text: string) => void }) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [webSpeechSupported] = useState(() => Boolean(speechRecognition()));
    const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);
    const [maxSeconds, setMaxSeconds] = useState(60);
    const [phase, setPhase] = useState<VoicePhase>("idle");
    const [seconds, setSeconds] = useState(0);

    const channel = resolveVoiceChannel(asrAvailable, webSpeechSupported);
    const mounted = useRef(true);
    const probeGeneration = useRef(0);
    const latest = useRef({ onTranscribed, language: i18n.resolvedLanguage, message });
    latest.current = { onTranscribed, language: i18n.resolvedLanguage, message };

    const recognitionRef = useRef<Recognition | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const clockRef = useRef<number | undefined>(undefined);
    const deadlineRef = useRef<number | undefined>(undefined);
    const abortRef = useRef<AbortController | null>(null);

    const clearRecordingTimers = () => {
        if (clockRef.current !== undefined) window.clearInterval(clockRef.current);
        if (deadlineRef.current !== undefined) window.clearTimeout(deadlineRef.current);
        clockRef.current = undefined;
        deadlineRef.current = undefined;
    };

    const releaseStream = () => {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    };

    useEffect(() => {
        mounted.current = true;
        const generation = ++probeGeneration.current;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 8000);
        fetchAudioTranscribeStatus(controller.signal)
            .then(status => {
                if (probeGeneration.current !== generation) return;
                setAsrAvailable(Boolean(status.available));
                if (status.maxSeconds && status.maxSeconds > 0) setMaxSeconds(status.maxSeconds);
            })
            .catch(() => {
                // Capability is optional: any probe failure degrades to Web Speech, never a fake button.
                if (probeGeneration.current === generation) setAsrAvailable(false);
            })
            .finally(() => window.clearTimeout(timer));
        return () => {
            mounted.current = false;
            probeGeneration.current++;
            controller.abort();
            window.clearTimeout(timer);
            clearRecordingTimers();
            recognitionRef.current?.stop();
            recognitionRef.current = null;
            const recorder = recorderRef.current;
            recorderRef.current = null;
            if (recorder && recorder.state !== "inactive") {
                recorder.ondataavailable = null;
                recorder.onstop = null;
                recorder.onerror = null;
                try { recorder.stop(); } catch { /* device already gone */ }
            }
            releaseStream();
            chunksRef.current = [];
            abortRef.current?.abort();
            abortRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const submitRecording = async (blob: Blob) => {
        const controller = new AbortController();
        abortRef.current = controller;
        setPhase("transcribing");
        try {
            const result = await transcribeAudioClip(blob, { language: latest.current.language, signal: controller.signal });
            if (!mounted.current) return;
            const text = result.text?.trim();
            if (text) latest.current.onTranscribed(text);
            else latest.current.message.warning(t("creativePad.voiceNoSpeech"));
        } catch (error) {
            if (!mounted.current || (error instanceof DOMException && error.name === "AbortError")) return;
            const reason = error instanceof Error ? error.message : String(error);
            latest.current.message.error(t("creativePad.voiceTranscribeFailed", { reason }));
        } finally {
            if (mounted.current) setPhase("idle");
            abortRef.current = null;
        }
    };

    const startRecording = async () => {
        if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
            message.error(t("creativePad.voiceRecorderUnsupported"));
            return;
        }
        let stream: MediaStream | undefined;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (!mounted.current) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            const recorder = new MediaRecorder(stream);
            streamRef.current = stream;
            recorderRef.current = recorder;
            chunksRef.current = [];
            recorder.ondataavailable = event => {
                if (event.data.size) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                clearRecordingTimers();
                releaseStream();
                const mimeType = recorder.mimeType || "audio/webm";
                const blob = new Blob(chunksRef.current, { type: mimeType });
                chunksRef.current = [];
                recorderRef.current = null;
                if (!mounted.current) return;
                if (blob.size) void submitRecording(blob);
                else {
                    setPhase("idle");
                    latest.current.message.warning(t("creativePad.voiceEmpty"));
                }
            };
            recorder.onerror = () => {
                clearRecordingTimers();
                releaseStream();
                recorderRef.current = null;
                chunksRef.current = [];
                if (mounted.current) {
                    setPhase("idle");
                    latest.current.message.error(t("creativePad.voiceMicError"));
                }
            };
            recorder.start(250);
            const startedAt = Date.now();
            setSeconds(0);
            setPhase("recording");
            clockRef.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
            deadlineRef.current = window.setTimeout(() => {
                const active = recorderRef.current;
                if (active && active.state !== "inactive") {
                    try { active.stop(); } catch { /* handled by onerror */ }
                }
            }, maxSeconds * 1000);
        } catch (error) {
            stream?.getTracks().forEach(track => track.stop());
            streamRef.current = null;
            recorderRef.current = null;
            clearRecordingTimers();
            if (mounted.current) {
                setPhase("idle");
                message.error(t("creativePad.voiceMicError"));
            }
        }
    };

    const stopRecording = () => {
        const recorder = recorderRef.current;
        if (!recorder) return;
        if (recorder.state !== "inactive") {
            try { recorder.stop(); } catch { /* handled by onerror */ }
        }
    };

    const startWebSpeech = () => {
        const Constructor = speechRecognition();
        if (!Constructor) return;
        const instance = new Constructor();
        instance.lang = i18n.resolvedLanguage?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
        instance.continuous = false;
        instance.interimResults = false;
        instance.onresult = event => {
            const results = event.results;
            const text = results ? Array.from(results).map(row => row?.[0]?.transcript || "").join(" ").trim() : "";
            if (text) latest.current.onTranscribed(text);
        };
        instance.onerror = () => setPhase("idle");
        instance.onend = () => {
            if (mounted.current) setPhase("idle");
            recognitionRef.current = null;
        };
        recognitionRef.current = instance;
        try {
            instance.start();
            setPhase("listening");
        } catch {
            recognitionRef.current = null;
            setPhase("idle");
        }
    };

    const toggle = () => {
        if (phase !== "idle") {
            if (phase === "recording") stopRecording();
            else if (phase === "transcribing") {
                abortRef.current?.abort();
                abortRef.current = null;
                setPhase("idle");
            } else recognitionRef.current?.stop();
            return;
        }
        if (channel === "asr") void startRecording();
        else if (channel === "web-speech") startWebSpeech();
    };

    const busy = phase !== "idle";
    const label = phase === "recording" ? t("creativePad.voiceRecording", { seconds })
        : phase === "transcribing" ? t("creativePad.voiceTranscribing")
            : phase === "listening" ? t("creativePad.voiceListening")
                : t("creativePad.voice");
    const tooltip = channel === "asr" ? t("creativePad.voiceAsrHint", { seconds: maxSeconds })
        : channel === "web-speech" ? t("creativePad.voiceBrowserHint")
            : t("creativePad.voiceUnsupported");

    return (
        <Tooltip title={tooltip}>
            <button
                type="button"
                data-testid="creative-voice"
                data-voice-channel={channel}
                data-voice-state={phase}
                aria-label={label}
                aria-pressed={busy}
                disabled={disabled || channel === "none"}
                onClick={toggle}
                className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs transition-colors",
                    phase === "recording" ? "border-destructive/50 bg-destructive/10 text-destructive"
                        : busy ? "border-primary/40 bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    (channel === "none" || disabled) && "cursor-not-allowed opacity-50",
                )}
            >
                {phase === "recording" ? <Square className="size-3.5" aria-hidden="true" />
                    : phase === "transcribing" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        : <Mic className={cn("size-3.5", phase === "listening" && "animate-pulse")} aria-hidden="true" />}
                <span className="hidden sm:inline">{label}</span>
            </button>
        </Tooltip>
    );
}
