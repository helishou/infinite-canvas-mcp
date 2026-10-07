import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, Heart, Pause, Play, RotateCcw, Sparkles, Timer, Waves } from "lucide-react";

import "./pelican-bike.css";

type RideStatus = "ready" | "playing" | "paused" | "finished";
type Lane = 0 | 1 | 2;
type EntityKind = "fish" | "shell";
type RideEntity = { id: number; x: number; lane: Lane; kind: EntityKind };
type Runtime = {
    elapsed: number;
    lastFrame: number;
    spawnIn: number;
    nextId: number;
    planIndex: number;
    entities: RideEntity[];
    lane: Lane;
    jumpUntil: number;
    score: number;
    fish: number;
    distance: number;
    hearts: number;
};

const RIDE_SECONDS = 60;
const PLAYER_X = 310;
const LANE_GROUND = [475, 514, 553] as const;
const RIDE_PLAN: { kind: EntityKind; lane: Lane; gap: number }[] = [
    { kind: "fish", lane: 1, gap: 1.75 },
    { kind: "shell", lane: 0, gap: 1.55 },
    { kind: "fish", lane: 2, gap: 1.72 },
    { kind: "shell", lane: 2, gap: 1.6 },
    { kind: "fish", lane: 1, gap: 1.72 },
    { kind: "shell", lane: 1, gap: 1.55 },
    { kind: "fish", lane: 0, gap: 1.72 },
    { kind: "shell", lane: 0, gap: 1.6 },
];

function newRuntime(): Runtime {
    return { elapsed: 0, lastFrame: 0, spawnIn: 0.8, nextId: 1, planIndex: 0, entities: [], lane: 1, jumpUntil: 0, score: 0, fish: 0, distance: 0, hearts: 3 };
}

function PelicanRider({ jumping, riding }: { jumping: boolean; riding: boolean }) {
    return (
        <g className={`pelican-rider${jumping ? " is-jumping" : ""}${riding ? " is-riding" : ""}`}>
            <g className="bike-wheels">
                {[57, 187].map((cx) => (
                    <g key={cx} className="bike-wheel" transform={`translate(${cx} 126)`}>
                        <circle r="42" fill="#f8f4e6" stroke="#173f40" strokeWidth="7" />
                        <circle r="4" fill="#e98150" />
                        {[0, 45, 90, 135].map((angle) => (
                            <line key={angle} x1="0" y1="0" x2="0" y2="-37" transform={`rotate(${angle})`} stroke="#173f40" strokeWidth="2" opacity=".8" />
                        ))}
                    </g>
                ))}
            </g>

            <g fill="none" stroke="#e98150" strokeLinecap="round" strokeLinejoin="round" strokeWidth="7">
                <path d="M57 126 101 76 119 126 57 126 187 126 158 67 101 76" />
                <path d="M93 69h20m-12 0 1 7m66-13 13-4m-8 4 4 7" />
            </g>
            <circle cx="119" cy="126" r="7" fill="#173f40" />
            <path d="M110 126h18m-9-9v18" stroke="#173f40" strokeWidth="4" strokeLinecap="round" />
            <path d="m92 68-8-8m-2 0h17" stroke="#173f40" strokeWidth="5" strokeLinecap="round" />

            {/* Little raincoat body, curved neck, and unmistakable scoop-shaped bill. */}
            <path d="M91 59c4-23 24-34 47-26 12 4 20 15 21 31l-9 19c-20 14-47 8-59-7Z" fill="#fff9e9" stroke="#173f40" strokeWidth="4" />
            <path d="M111 56c12-8 27-7 38 1l-7 18c-11 7-22 6-32 1Z" fill="#e9a45f" />
            <path d="M144 37c-7-18 2-33 19-34 14-1 24 9 22 22-1 10-10 18-24 18Z" fill="#fff9e9" stroke="#173f40" strokeWidth="4" />
            <path d="M176 23c22 2 44 7 62 14-18 17-43 22-63 12-8-4-12-10-14-18Z" fill="#e98150" stroke="#173f40" strokeWidth="4" strokeLinejoin="round" />
            <path d="M174 37c15 2 31 3 48 1-9 11-24 15-39 10-6-2-9-6-9-11Z" fill="#d96b43" />
            <circle cx="169" cy="20" r="3.5" fill="#173f40" />
            <path d="M143 5c4-10 17-15 30-12 8 2 13 7 15 14-10-3-21-1-30 5Z" fill="#69a99a" stroke="#173f40" strokeWidth="4" strokeLinejoin="round" />
            <path d="M101 81c8 4 18 5 28 2" fill="none" stroke="#d88f4f" strokeWidth="3" strokeLinecap="round" />

            {/* Legs on the pedals, with tiny coral cycling shoes. */}
            <path d="m113 78 6 39m18-37-17 35" stroke="#e98150" strokeWidth="5" strokeLinecap="round" />
            <path d="M116 119c-1 5 0 9 5 10 4 0 7-2 7-5v-4Zm-5-2c-4 2-6 6-4 9 2 3 6 3 10 1l3-4Z" fill="#e98150" stroke="#173f40" strokeWidth="2.5" strokeLinejoin="round" />
        </g>
    );
}

function RideScene({ view, status }: { view: Runtime; status: RideStatus }) {
    const jumping = status === "playing" && view.elapsed < view.jumpUntil;
    return (
        <svg className="pelican-world" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" role="img" aria-label="鹈鹕骑着自行车沿海岸骑行">
            <defs>
                <linearGradient id="pelican-sky" x2="0" y2="1">
                    <stop stopColor="#d7e8d9" />
                    <stop offset="1" stopColor="#f2e6c8" />
                </linearGradient>
                <linearGradient id="pelican-sea" x2="0" y2="1">
                    <stop stopColor="#7db9ae" />
                    <stop offset="1" stopColor="#458f8a" />
                </linearGradient>
                <pattern id="pelican-road-dots" width="34" height="34" patternUnits="userSpaceOnUse">
                    <circle cx="3" cy="7" r="1.1" fill="#507c6c" opacity=".18" />
                    <circle cx="22" cy="23" r=".8" fill="#507c6c" opacity=".14" />
                </pattern>
            </defs>
            <rect width="1000" height="600" fill="url(#pelican-sky)" />
            <circle cx="790" cy="112" r="53" fill="#f4b368" opacity=".95" />
            <circle cx="790" cy="112" r="69" fill="none" stroke="#f4b368" strokeWidth="1.5" opacity=".35" />
            <g className="pelican-clouds" fill="#f8f4e6" opacity=".88">
                <path d="M111 158c1-17 15-29 32-27 7-20 34-23 46-6 22-4 39 13 35 33Z" />
                <path d="M512 199c2-13 13-22 27-20 7-16 29-17 38-2 17-3 29 10 26 22Z" opacity=".72" />
            </g>
            <path d="M0 279c87-19 157-18 235 1s142 21 216 4 145-28 222-8 167 26 327 5v121H0Z" fill="#6caa9e" />
            <path d="M0 314c106-15 170-11 259 8s167 13 250-3 164-20 248-1 158 20 243 5v78H0Z" fill="url(#pelican-sea)" />
            <g className="pelican-waterlines" fill="none" stroke="#d7e8d9" strokeWidth="3" strokeLinecap="round" opacity=".7">
                <path d="M42 332h91m31 0h42m307 14h78m35 0h44m116-16h68m45 0h52" />
                <path d="M107 365h66m79 0h39m331-10h45m96 11h39m83 0h64" />
            </g>
            <path d="M0 391c130-22 221-2 344 3s212-31 337-16 219 24 319 8v43H0Z" fill="#e4c89c" />
            <path d="M0 427c170-17 246 7 393 5s224-24 359-12 185 8 248 0v47H0Z" fill="#d6b58a" />
            <g fill="#f7e8c9" opacity=".9">
                <path d="M658 390c15-13 32-12 42 0-9 10-27 12-42 0Zm62 4c13-11 26-9 34 1-8 8-22 9-34-1Zm-595-5c12-9 24-8 31 1-7 8-20 9-31-1Z" />
            </g>

            <path d="M0 453c207-15 383 7 560-1s295-17 440-3v151H0Z" fill="#eadbb9" />
            <path d="M0 453c207-15 383 7 560-1s295-17 440-3v151H0Z" fill="url(#pelican-road-dots)" />
            <path d="M0 478c184-12 358 7 551 0s298-13 449-3" fill="none" stroke="#b5a783" strokeWidth="2" opacity=".55" />
            <path d="M0 517c184-9 360 6 552 0s298-11 448-3" fill="none" stroke="#b5a783" strokeWidth="2" opacity=".52" />
            <path d="M0 556c184-8 360 6 552 0s298-9 448-2" fill="none" stroke="#b5a783" strokeWidth="2" opacity=".48" />
            <path d="M0 587c220-4 440 4 646 0s257-4 354 0" fill="none" stroke="#c4ae83" strokeWidth="2" opacity=".55" />

            {view.entities.map((entity) => (
                <g key={entity.id} transform={`translate(${entity.x} ${LANE_GROUND[entity.lane]})`} className="pelican-entity">
                    {entity.kind === "fish" ? (
                        <g className="fish-prize" transform="translate(0 -25)">
                            <ellipse rx="21" ry="15" fill="#f6ad5d" stroke="#173f40" strokeWidth="3" />
                            <path d="m18 0 16-12v24Z" fill="#e98150" stroke="#173f40" strokeWidth="3" strokeLinejoin="round" />
                            <circle cx="-10" cy="-3" r="2.5" fill="#173f40" />
                            <path d="M-2-7q7 7 0 14" fill="none" stroke="#fff2d5" strokeWidth="2" />
                            <path d="M-25-24c-14-13 7-21 0-32" fill="none" stroke="#f7f4e9" strokeWidth="3" strokeLinecap="round" opacity=".9" />
                        </g>
                    ) : (
                        <g transform="translate(0 -27)">
                            <path d="M-22 14q0-22 22-29 22 7 22 29Z" fill="#e98150" stroke="#173f40" strokeWidth="3" />
                            <path d="M-23 14h46" stroke="#173f40" strokeWidth="4" strokeLinecap="round" />
                            <circle cx="-8" cy="2" r="2.4" fill="#fff9e9" />
                            <circle cx="8" cy="2" r="2.4" fill="#fff9e9" />
                            <path d="M-13 20v5m13-5v5m13-5v5" stroke="#173f40" strokeWidth="3" strokeLinecap="round" />
                        </g>
                    )}
                </g>
            ))}

            <g className="pelican-rider-position" transform={`translate(200 ${LANE_GROUND[view.lane] - 170})`}>
                <PelicanRider jumping={jumping} riding={status === "playing"} />
            </g>
            <g transform="translate(895 421)" opacity=".8">
                <path d="M0 31v-26m0 9 14-10m-14 8L-9 1" fill="none" stroke="#244c45" strokeWidth="4" strokeLinecap="round" />
                <path d="M-17 31h34" stroke="#244c45" strokeWidth="4" strokeLinecap="round" />
                <circle cx="15" cy="0" r="4" fill="#e98150" />
            </g>
            <path d="M45 402q8-12 16 0m6 0q8-12 16 0m802-20q6-9 12 0m6 0q6-9 12 0" fill="none" stroke="#173f40" strokeWidth="3" strokeLinecap="round" opacity=".68" />
        </svg>
    );
}

export default function PelicanBikePage() {
    const runtime = useRef<Runtime>(newRuntime());
    const [status, setStatus] = useState<RideStatus>("ready");
    const [view, setView] = useState<Runtime>(newRuntime());
    const [best, setBest] = useState(() => {
        try {
            return Number(window.localStorage.getItem("pelican-bike-best") || 0);
        } catch {
            return 0;
        }
    });

    const syncView = (source = runtime.current) => setView({ ...source, entities: source.entities.map((entity) => ({ ...entity })) });

    const startRide = () => {
        runtime.current = newRuntime();
        syncView();
        setStatus("playing");
    };

    const switchLane = (direction: -1 | 1) => {
        if (status !== "playing") return;
        const next = Math.max(0, Math.min(2, runtime.current.lane + direction)) as Lane;
        runtime.current.lane = next;
        syncView();
    };

    const hop = () => {
        if (status !== "playing") return;
        runtime.current.jumpUntil = runtime.current.elapsed + 0.72;
        syncView();
    };

    useEffect(() => {
        if (status !== "playing") return;
        let frame = 0;
        let lastPaint = 0;
        const tick = (now: number) => {
            const game = runtime.current;
            if (!game.lastFrame) game.lastFrame = now;
            const dt = Math.min((now - game.lastFrame) / 1000, 0.06);
            game.lastFrame = now;
            game.elapsed += dt;
            const speed = 245 + Math.min(game.elapsed * 2.1, 130);
            game.distance += (dt * speed) / 42;
            game.spawnIn -= dt;

            if (game.spawnIn <= 0) {
                const plan = RIDE_PLAN[game.planIndex % RIDE_PLAN.length];
                game.entities.push({ id: game.nextId++, x: 1060, lane: plan.lane, kind: plan.kind });
                game.planIndex += 1;
                game.spawnIn = plan.gap;
            }

            const survivors: RideEntity[] = [];
            for (const entity of game.entities) {
                const previousX = entity.x;
                entity.x -= speed * dt;
                const meetsRider = previousX > PLAYER_X + 25 && entity.x <= PLAYER_X + 25;
                if (meetsRider && entity.lane === game.lane) {
                    if (entity.kind === "fish") {
                        game.fish += 1;
                        game.score += 100;
                    } else if (game.elapsed >= game.jumpUntil) {
                        game.hearts = Math.max(0, game.hearts - 1);
                    }
                    continue;
                }
                if (entity.x > -50) survivors.push(entity);
            }
            game.entities = survivors;
            game.score = Math.max(game.score, Math.floor(game.distance));

            if (now - lastPaint > 35 || game.hearts === 0 || game.elapsed >= RIDE_SECONDS) {
                syncView(game);
                lastPaint = now;
            }
            if (game.hearts === 0 || game.elapsed >= RIDE_SECONDS) {
                const finalScore = game.score;
                setBest((previous) => {
                    const updated = Math.max(previous, finalScore);
                    try {
                        window.localStorage.setItem("pelican-bike-best", String(updated));
                    } catch {
                        /* Private browsing may disable storage. */
                    }
                    return updated;
                });
                setStatus("finished");
                return;
            }
            frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(frame);
    }, [status]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement | null)?.tagName || "")) return;
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) event.preventDefault();
            if (event.code === "ArrowLeft" || event.code === "KeyA") switchLane(-1);
            else if (event.code === "ArrowRight" || event.code === "KeyD") switchLane(1);
            else if (event.code === "ArrowUp" || event.code === "Space" || event.code === "KeyW") hop();
            else if (event.code === "Escape" || event.code === "KeyP") setStatus((current) => (current === "playing" ? "paused" : current === "paused" ? "playing" : current));
            else if (event.code === "Enter" && status !== "playing") startRide();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [status]);

    const timeLeft = Math.max(0, Math.ceil(RIDE_SECONDS - view.elapsed));
    const progress = Math.min(100, (view.elapsed / RIDE_SECONDS) * 100);

    return (
        <main className="pelican-page">
            <header className="pelican-topbar">
                <a className="pelican-wordmark" href="/" aria-label="回到无限画布">
                    <span className="pelican-mark">
                        <Waves size={18} strokeWidth={2.2} />
                    </span>
                    <span>
                        PEL<span className="wordmark-sun">I</span>CAN
                        <br />
                        <small>COASTAL CLUB</small>
                    </span>
                </a>
                <div className="pelican-top-note">
                    <span className="live-dot" /> BAY LOOP / NO. 01
                </div>
                <a className="pelican-back" href="/">
                    返回工作台 <ArrowRight size={14} />
                </a>
            </header>

            <section className="pelican-intro">
                <div>
                    <p className="pelican-kicker">
                        <span>01</span> 海风湾 · 海岸骑行赛
                    </p>
                    <h1>
                        今天，沿着海岸
                        <br />
                        <em>慢慢骑。</em>
                    </h1>
                </div>
                <p className="pelican-intro-note">
                    一只鹈鹕，一辆老式单车。
                    <br />
                    躲开小螃蟹，顺路捡几条鱼。
                </p>
                <div className="pelican-weather">
                    <span className="sun-stamp">☼</span>
                    <span>
                        海风轻轻
                        <br />
                        <b>24° / 顺风</b>
                    </span>
                </div>
            </section>

            <section className="pelican-content" aria-label="鹈鹕海岸骑行游戏">
                <div className={`pelican-stage status-${status}`}>
                    <RideScene view={view} status={status} />
                    <div className="stage-topline">
                        <span>
                            <span className="stage-indicator" /> LIVE COAST CAM
                        </span>
                        <span>36° 49′ N&nbsp;&nbsp; 121° 47′ W</span>
                    </div>
                    <div className="stage-stats">
                        <div>
                            <span>得分</span>
                            <b>{view.score.toString().padStart(4, "0")}</b>
                        </div>
                        <div>
                            <span>海岸里程</span>
                            <b>
                                {view.distance.toFixed(1)} <small>km</small>
                            </b>
                        </div>
                        <div className="stage-lives" aria-label={`剩余 ${view.hearts} 条命`}>
                            {Array.from({ length: 3 }, (_, i) => (
                                <Heart key={i} size={17} fill={i < view.hearts ? "currentColor" : "transparent"} className={i < view.hearts ? "heart-on" : "heart-off"} />
                            ))}
                        </div>
                    </div>

                    {status !== "playing" && (
                        <div className="ride-overlay">
                            {status === "ready" && (
                                <div className="overlay-card">
                                    <span className="overlay-eyebrow">
                                        <Sparkles size={14} /> THE 60-SECOND COASTAL RIDE
                                    </span>
                                    <h2>准备好去兜风了吗？</h2>
                                    <p>踩踏板，追着海风，把路上的小鱼装进口袋。</p>
                                    <button type="button" className="ride-primary" onClick={startRide}>
                                        <Play size={16} fill="currentColor" /> 开始骑行
                                    </button>
                                    <span className="overlay-hint">
                                        或按 <kbd>ENTER</kbd> 出发
                                    </span>
                                </div>
                            )}
                            {status === "paused" && (
                                <div className="overlay-card">
                                    <span className="overlay-eyebrow">
                                        <Pause size={14} /> RIDE PAUSED
                                    </span>
                                    <h2>停下来看看海。</h2>
                                    <p>休息好了，再继续追风。</p>
                                    <button type="button" className="ride-primary" onClick={() => setStatus("playing")}>
                                        <Play size={16} fill="currentColor" /> 继续骑行
                                    </button>
                                </div>
                            )}
                            {status === "finished" && (
                                <div className="overlay-card">
                                    <span className="overlay-eyebrow">
                                        <FlagIcon /> FINISH LINE
                                    </span>
                                    <h2>{view.hearts ? "这一程，骑得真不错。" : "螃蟹赢了这一回。"}</h2>
                                    <p>
                                        本次得分 <b>{view.score}</b> · 捡到 <b>{view.fish}</b> 条鱼 · 骑过 <b>{view.distance.toFixed(1)}</b> km
                                    </p>
                                    <button type="button" className="ride-primary" onClick={startRide}>
                                        <RotateCcw size={16} /> 再骑一程
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="stage-bottomline">
                        <span>
                            <span className="stage-wave" /> PACIFIC COAST PATH
                        </span>
                        <button type="button" className="stage-pause" onClick={() => setStatus((current) => (current === "playing" ? "paused" : current === "paused" ? "playing" : current))} aria-label={status === "playing" ? "暂停" : "继续"}>
                            {status === "playing" ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                    </div>
                    <div className="lane-dots" aria-label={`当前在第 ${view.lane + 1} 条车道`}>
                        {[0, 1, 2].map((lane) => (
                            <span key={lane} className={lane === view.lane ? "active" : ""} />
                        ))}
                    </div>
                </div>

                <aside className="pelican-rail">
                    <div className="ride-clock">
                        <div className="rail-label">
                            <Timer size={14} /> 今日骑行
                        </div>
                        <div className="clock-value">00:{timeLeft.toString().padStart(2, "0")}</div>
                        <div className="ride-progress">
                            <span style={{ width: `${progress}%` }} />
                        </div>
                        <div className="clock-caption">
                            <span>海风湾环线</span>
                            <span>01:00</span>
                        </div>
                    </div>
                    <div className="rail-divider" />
                    <div className="rail-score">
                        <span>
                            最高纪录 <Sparkles size={14} />
                        </span>
                        <b>{best.toString().padStart(4, "0")}</b>
                        <small>本地保存 · 仅属于你</small>
                    </div>
                    <div className="rail-divider" />
                    <div className="controls-block">
                        <div className="controls-title">
                            怎么骑 <span>CONTROLS</span>
                        </div>
                        <div className="control-row">
                            <div className="key-group">
                                <kbd>
                                    <ArrowLeft size={13} />
                                </kbd>
                                <kbd>
                                    <ArrowRight size={13} />
                                </kbd>
                            </div>
                            <span>左右换道</span>
                        </div>
                        <div className="control-row">
                            <div className="key-group">
                                <kbd>
                                    <ArrowUp size={13} />
                                </kbd>
                                <kbd className="space-key">SPACE</kbd>
                            </div>
                            <span>跃过螃蟹</span>
                        </div>
                    </div>
                    <div className="mobile-controls">
                        <button type="button" aria-label="向左换道" onClick={() => switchLane(-1)}>
                            <ArrowLeft size={19} />
                        </button>
                        <button type="button" aria-label="跳跃" onClick={hop}>
                            <ArrowUp size={18} />
                        </button>
                        <button type="button" aria-label="向右换道" onClick={() => switchLane(1)}>
                            <ArrowRight size={19} />
                        </button>
                    </div>
                    <div className="rail-foot">
                        <span className="foot-doodle">✳</span>
                        <p>
                            不赶时间，
                            <br />
                            就很好。
                        </p>
                        <small>TAKE THE SCENIC ROUTE</small>
                    </div>
                </aside>
            </section>

            <footer className="pelican-footer">
                <span>PEL I CAN, PEL I CAN.</span>
                <span>一圈海岸 · 一点好心情</span>
                <span className="footer-right">
                    MADE FOR A SUNNY DAY <span>✳</span>
                </span>
            </footer>
        </main>
    );
}

function FlagIcon() {
    return (
        <span className="flag-icon" aria-hidden="true">
            ⚑
        </span>
    );
}
