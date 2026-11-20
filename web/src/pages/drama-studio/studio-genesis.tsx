import { CheckCircle2, Circle, Loader2, PauseCircle } from "lucide-react";

import {
    deriveGenesisCopy,
    deriveGenesisSteps,
    genesisStepState,
    type StudioGenesisInput,
} from "./studio-genesis-model";
import "./studio-genesis.css";

/**
 * 影策 StudioGenesis 的本地移植：全剧第一集出现前的四步卡。
 * 只用真值：productionState + source_chapters 章节元信息 + 共享资产 + 第 1 集成片；
 * 暂停态用调用方按剧目持久化的真实 paused，数字缺失时不写 0。
 */
export function StudioGenesis(props: StudioGenesisInput) {
    const copy = deriveGenesisCopy(props);
    const steps = deriveGenesisSteps(props);
    return (
        <div className="drama-genesis" data-studio-genesis="">
            <div className="drama-genesis-card">
                {copy.icon === "pause" ? (
                    <PauseCircle className="mx-auto mb-5 size-16 text-amber-500" data-studio-genesis-pause />
                ) : (
                    <div className="drama-genesis-orb" aria-hidden data-studio-genesis-orb />
                )}
                <h2 data-studio-genesis-heading>{copy.heading}</h2>
                <p data-studio-genesis-description>{copy.description}</p>
                <div className="drama-genesis-steps">
                    {steps.map((step) => {
                        const state = genesisStepState(step, copy.paused);
                        return (
                            <div
                                key={step.key}
                                data-studio-genesis-step={step.key}
                                data-step-state={state}
                                className={`drama-genesis-step ${state === "done" ? "is-done" : state === "active" ? "is-active" : ""}`}
                            >
                                {state === "done" ? (
                                    <CheckCircle2 className="size-4 text-emerald-500" />
                                ) : state === "active" ? (
                                    <Loader2 className="size-4 animate-spin text-primary" />
                                ) : (
                                    <Circle className="size-4 opacity-35" />
                                )}
                                {step.label}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
