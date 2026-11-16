/**
 * One authoritative decision for the voice button: the Backend ASR channel wins when ready,
 * browser-native recognition is only a fallback, and the control is disabled when neither works.
 * `null` means the capability probe has not produced a trustworthy answer yet.
 */
export type VoiceChannel = "asr" | "web-speech" | "none";

export function resolveVoiceChannel(asrAvailable: boolean | null, webSpeechSupported: boolean): VoiceChannel {
    if (asrAvailable === true) return "asr";
    return webSpeechSupported ? "web-speech" : "none";
}
