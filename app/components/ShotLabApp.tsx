"use client";

import {
  Activity,
  ArrowLeft,
  BarChart3,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Cloud,
  CloudOff,
  Download,
  Gauge,
  History,
  Home,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Play,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Upload,
  Video,
  Wifi,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  analyzePoseFrames,
  compareOutcomes,
  deriveCoachingInsight,
  roundMetric,
  type AnalysisResult,
} from "../lib/metrics";
import {
  localSettingsStore,
  localShotStore,
  localVideoStore,
  reassignLocalOwner,
  shotsForViewer,
} from "../lib/local-db";
import {
  cloudShotStore,
  cloudVideoStore,
  firebaseAuth,
} from "../lib/firebase";
import { PendingUploadError, flushPendingShotUploads, flushShotDeletions, videoUploadFailureMessage } from "../lib/shot-sync";
import { analyzeVideoElement } from "../lib/pose-engine";
import {
  DEFAULT_SHOTLAB_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SHOT_RECORD_SCHEMA_VERSION,
  type Handedness,
  type PoseAnalysisSummary,
  type PoseFrame,
  type ShotLabSettings,
  type ShotLabUser,
  type ShotMetrics,
  type ShotRecord,
  type ShotResult,
} from "../lib/types";
import { PoseOverlay } from "./PoseOverlay";
import { ThemeToggle } from "./ThemeToggle";

type Screen = "home" | "analyze" | "history" | "settings";
type AnalyzePhase = "pick" | "ready" | "running" | "result";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface Notice {
  tone: "success" | "warning" | "error";
  text: string;
}

const NAV_ITEMS: Array<{
  id: Screen;
  label: string;
  icon: typeof Home;
}> = [
  { id: "home", label: "Lab", icon: Home },
  { id: "analyze", label: "Analyze", icon: Camera },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const METRIC_CARDS: Array<{
  key: keyof ShotMetrics;
  label: string;
  format(value: number): string;
  sublabel: string;
}> = [
  {
    key: "elbowAngleDeg",
    label: "Release elbow",
    format: (value) => `${Math.round(value)}°`,
    sublabel: "arm extension",
  },
  {
    key: "kneeAngleDeg",
    label: "Knee at load",
    format: (value) => `${Math.round(value)}°`,
    sublabel: "lowest load frame",
  },
  {
    key: "torsoLeanDeg",
    label: "Torso lean",
    format: (value) => `${roundMetric(value, 1)}°`,
    sublabel: "at release estimate",
  },
  {
    key: "baseWidthRatio",
    label: "Base width",
    format: (value) => `${roundMetric(value, 2)}×`,
    sublabel: "shoulder width",
  },
  {
    key: "jumpDrift",
    label: "Jump drift",
    format: (value) => `${roundMetric(value, 2)}×`,
    sublabel: "shoulder width",
  },
  {
    key: "releaseTimingSeconds",
    label: "Release timing",
    format: (value) => `${roundMetric(value, 2)}s`,
    sublabel: "after upward motion",
  },
  {
    key: "hipAngleDeg",
    label: "Hip angle",
    format: (value) => `${roundMetric(value, 1)}°`,
    sublabel: "at the load",
  },
  {
    key: "shoulderTiltDeg",
    label: "Shoulder tilt",
    format: (value) => `${roundMetric(value, 1)}°`,
    sublabel: "at release",
  },
  {
    key: "landingWidthRatio",
    label: "Landing width",
    format: (value) => `${roundMetric(value, 2)}×`,
    sublabel: "shoulder width",
  },
  {
    key: "landingDisplacement",
    label: "Landing drift",
    format: (value) => `${roundMetric(value, 2)}×`,
    sublabel: "shoulder width",
  },
  {
    key: "landingLateralDisplacement",
    label: "Landing side drift",
    format: (value) => `${roundMetric(value, 2)}×`,
    sublabel: "shoulder width",
  },
];

function newId(prefix: string) {
  return typeof crypto.randomUUID === "function"
    ? `${prefix}_${crypto.randomUUID()}`
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${roundMetric(bytes / 1024 / 1024, 1)} MB`;
}

function metricNumber(metrics: ShotMetrics, key: keyof ShotMetrics) {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatFinite(value: number | undefined, format: (value: number) => string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return format(value);
}

function formatComparisonValue(value: number | undefined, unit: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const digits = unit === "°" ? 1 : 2;
  return `${roundMetric(value, digits)}${unit}`;
}

function releasePhaseMarks(frames: PoseFrame[], summary: PoseAnalysisSummary) {
  const span = Math.max(1, frames.length - 1);
  const marks: Array<{ key: string; label: string; index: number }> = [];
  const add = (key: string, label: string, frameIndex: number | undefined) => {
    if (frameIndex === undefined) return;
    const index = frames.findIndex((frame) => frame.frameIndex === frameIndex);
    if (index < 0) return;
    const existing = marks.find((mark) => mark.index === index);
    if (existing) {
      existing.label = `${existing.label} / ${label}`;
      return;
    }
    marks.push({ key, label, index });
  };
  add("load", "Load", summary.loadFrame);
  add("release", "Release", summary.releaseFrame);
  add("landing", "Landing", summary.landingFrame);
  const placed = marks.map((mark) => ({ ...mark, percent: (mark.index / span) * 100 }));
  // Width is estimated for a 320px phone so nearby labels stack instead of painting on top of each other.
  const boxFor = (percent: number, label: string) => {
    const width = Math.min(92, 4 + label.length * 3.8);
    if (percent <= 8) return { start: percent, end: Math.min(100, percent + width) };
    if (percent >= 92) return { start: Math.max(0, percent - width), end: percent };
    return { start: Math.max(0, percent - width / 2), end: Math.min(100, percent + width / 2) };
  };
  const lanes: Array<Array<{ start: number; end: number }>> = [];
  const withLanes = placed.map((mark) => {
    const box = boxFor(mark.percent, mark.label);
    let lane = lanes.findIndex((row) => row.every((used) => box.end + 1.5 < used.start || box.start > used.end + 1.5));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(box);
    return { ...mark, lane };
  });
  const laneCount = Math.max(1, lanes.length);
  return withLanes.map((mark) => ({ ...mark, lanes: laneCount }));
}

function protectShotIds(
  ids: readonly string[],
  ownerId: string,
  preserveIds: Set<string>,
  preserveOwner: { current: string | null },
) {
  if (!ids.length) return;
  if (preserveOwner.current !== null && preserveOwner.current !== ownerId) return;
  preserveOwner.current = ownerId;
  for (const id of ids) preserveIds.add(id);
}

function isVideoFile(file: File) {
  if (file.type.startsWith("video/")) return true;
  if (!/\.(mp4|m4v|mov|webm|ogv|ogg|mkv|avi|mpeg|mpg)$/i.test(file.name)) return false;
  return file.type === "" || file.type === "application/octet-stream";
}

function mergeShots(local: ShotRecord[], incoming: ShotRecord[]) {
  const byId = new Map(local.map((shot) => [shot.id, shot]));
  incoming.forEach((shot) => {
    const existing = byId.get(shot.id);
    if (!existing || shot.updatedAt >= existing.updatedAt) byId.set(shot.id, shot);
  });
  return [...byId.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

function Brand() {
  return (
    <div className="brand-lockup" aria-label="ShotLab">
      <span className="brand-ball" aria-hidden="true">
        <span />
      </span>
      <span className="brand-word">
        SHOT<span>LAB</span>
      </span>
    </div>
  );
}

function StatusPill({ user, compact = false }: { user: ShotLabUser | null; compact?: boolean }) {
  const label = user ? (user.email ? `Cloud synced, ${user.email}` : "Cloud synced") : "Stored on this device";
  return (
    <span
      className={`status-pill ${compact ? "compact" : ""} ${user ? "is-online" : ""}`}
      title={user?.email ?? "Stored on this device"}
      {...(compact ? { role: "img" as const, "aria-label": label } : {})}
    >
      {user ? <Wifi size={14} /> : <CloudOff size={14} />}
      {!compact && (user ? "Cloud synced" : "On this device")}
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  action,
  titleLevel = "h2",
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  titleLevel?: "h1" | "h2";
}) {
  const TitleTag = titleLevel;
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <TitleTag>{title}</TitleTag>
      </div>
      {action}
    </div>
  );
}

function EmptyMetric() {
  return <span className="empty-metric">—</span>;
}

function ResultBadge({ result }: { result: ShotResult }) {
  if (result === "made") {
    return (
      <span className="result-badge made">
        <CircleCheck size={14} /> Made
      </span>
    );
  }
  if (result === "missed") {
    return (
      <span className="result-badge missed">
        <CircleX size={14} /> Missed
      </span>
    );
  }
  return <span className="result-badge unknown">Unmarked</span>;
}

function MetricGrid({ metrics }: { metrics: ShotMetrics }) {
  return (
    <div className="metric-grid">
      {METRIC_CARDS.map((definition) => {
        const value = metricNumber(metrics, definition.key);
        return (
          <article className="metric-card" key={definition.key}>
            <p>{definition.label}</p>
            <strong>{value === undefined ? <EmptyMetric /> : definition.format(value)}</strong>
            <span>{definition.sublabel}</span>
          </article>
        );
      })}
    </div>
  );
}

function HomeScreen({
  shots,
  user,
  onAnalyze,
  onHistory,
}: {
  shots: ShotRecord[];
  user: ShotLabUser | null;
  onAnalyze(): void;
  onHistory(shot?: ShotRecord): void;
}) {
  const marked = shots.filter((shot) => shot.result !== "unknown");
  const makes = marked.filter((shot) => shot.result === "made");
  const makeRate = marked.length ? Math.round((makes.length / marked.length) * 100) : undefined;
  const consistencyValues = shots
    .map((shot) => shot.metrics.releaseConsistencyPct)
    .filter((value): value is number => typeof value === "number");
  const averageConsistency = consistencyValues.length
    ? Math.round(consistencyValues.reduce((sum, value) => sum + value, 0) / consistencyValues.length)
    : undefined;
  const insight = deriveCoachingInsight(shots);

  return (
    <div className="screen-content home-screen">
      <section className="hero-card">
        <div className="hero-court-lines" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow light">YOUR FORM. YOUR DATA.</p>
          <h1>EVERY REP<br />LEAVES EVIDENCE.</h1>
          <p>
            Film one shot. ShotLab measures the motion on this device and learns what separates your makes from your misses.
          </p>
          <button className="primary-button light-button" type="button" onClick={onAnalyze}>
            <Camera size={19} /> Analyze a shot
          </button>
        </div>
        <div className="hero-release-card" aria-hidden="true">
          <span>RELEASE</span>
          <strong>164°</strong>
          <div className="mini-skeleton">
            <i className="head" />
            <i className="body" />
            <i className="arm-one" />
            <i className="arm-two" />
            <i className="leg-one" />
            <i className="leg-two" />
          </div>
        </div>
      </section>

      <section>
        <SectionHeading eyebrow="THIS DEVICE" title="Your training pulse" />
        <div className="pulse-grid">
          <article className="pulse-card">
            <div className="pulse-icon orange"><Target size={20} /></div>
            <div><span>Shots logged</span><strong>{shots.length || "0"}</strong></div>
          </article>
          <article className="pulse-card">
            <div className="pulse-icon lime"><Gauge size={20} /></div>
            <div><span>Make rate</span><strong>{makeRate === undefined ? "—" : `${makeRate}%`}</strong></div>
          </article>
          <article className="pulse-card">
            <div className="pulse-icon blue"><Activity size={20} /></div>
            <div><span>Consistency</span><strong>{averageConsistency === undefined ? "—" : `${averageConsistency}%`}</strong></div>
          </article>
        </div>
      </section>

      <div className="home-two-column">
        <section className="insight-card">
          <div className="insight-icon"><Sparkles size={20} /></div>
          <div>
            <p className="eyebrow">PERSONAL COACHING SIGNAL</p>
            <h3>{insight.title}</h3>
            <p>{insight.detail}</p>
          </div>
        </section>

        <section className="setup-card">
          <div className="setup-visual" aria-hidden="true">
            <span className="phone-shape"><i /></span>
            <span className="setup-player"><i /><b /><em /></span>
          </div>
          <div>
            <p className="eyebrow">BETTER INPUT, BETTER SIGNAL</p>
            <h3>Set the phone once.</h3>
            <ul className="check-list compact">
              <li><Check size={15} /> Landscape, fixed, chest height</li>
              <li><Check size={15} /> Full body and hoop visible</li>
              <li><Check size={15} /> Side or 45° view</li>
            </ul>
          </div>
        </section>
      </div>

      <section>
        <SectionHeading
          eyebrow={user ? "SYNCED HISTORY" : "LOCAL HISTORY"}
          title="Recent shots"
          action={shots.length ? (
            <button className="text-button" type="button" onClick={() => onHistory()}>View all <ChevronRight size={16} /></button>
          ) : null}
        />
        {shots.length ? (
          <div className="recent-list">
            {shots.slice(0, 3).map((shot) => (
              <button className="recent-shot" type="button" key={shot.id} onClick={() => onHistory(shot)}>
                <ResultBadge result={shot.result} />
                <span className="recent-shot-time">{formatDate(shot.recordedAt)}</span>
                <span className="recent-shot-metric">
                  <small>Elbow</small>
                  <b>{formatFinite(shot.metrics.elbowAngleDeg, (value) => `${Math.round(value)}°`)}</b>
                </span>
                <span className="recent-shot-metric">
                  <small>Drift</small>
                  <b>{formatFinite(shot.metrics.jumpDrift, (value) => `${roundMetric(value, 2)}×`)}</b>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-state-icon"><Video size={24} /></span>
            <div><h3>Your first rep starts the baseline.</h3><p>Record from the same angle each time so your comparisons mean something.</p></div>
            <button className="secondary-button" type="button" onClick={onAnalyze}><Plus size={17} /> Add first shot</button>
          </div>
        )}
      </section>
    </div>
  );
}

function SetupChecklist() {
  return (
    <section className="capture-guide">
      <div>
        <p className="eyebrow">PHONE PLACEMENT</p>
        <h3>Give the model a clean look.</h3>
        <p>Single-camera measurements are most useful when the angle stays repeatable.</p>
      </div>
      <ol>
        <li><span>01</span><div><b>Turn landscape</b><small>Use the native camera for the best frame rate.</small></div></li>
        <li><span>02</span><div><b>Frame body + hoop</b><small>Keep feet, release hand, and landing in view.</small></div></li>
        <li><span>03</span><div><b>Lock the position</b><small>Chest height, side or 45°, no handheld pan.</small></div></li>
      </ol>
    </section>
  );
}

function OutcomePicker({ value, onChange }: { value: ShotResult; onChange(value: ShotResult): void }) {
  return (
    <div className="outcome-picker" aria-label="Shot result">
      <button className={value === "made" ? "selected made" : ""} type="button" aria-pressed={value === "made"} onClick={() => onChange("made")}>
        <CircleCheck size={20} /> Made
      </button>
      <button className={value === "missed" ? "selected missed" : ""} type="button" aria-pressed={value === "missed"} onClick={() => onChange("missed")}>
        <CircleX size={20} /> Missed
      </button>
      <button className={value === "unknown" ? "selected" : ""} type="button" aria-pressed={value === "unknown"} onClick={() => onChange("unknown")}>
        Not sure
      </button>
    </div>
  );
}

function AnalysisResults({
  analysis,
  frames,
  history,
  releaseFrameIndex,
  onReleaseFrameChange,
}: {
  analysis: AnalysisResult;
  frames: PoseFrame[];
  history: ShotRecord[];
  releaseFrameIndex: number;
  onReleaseFrameChange(index: number): void;
}) {
  const comparisons = compareOutcomes(history, analysis.metrics);
  const releaseFrame = frames[releaseFrameIndex];
  const releaseMarks = releasePhaseMarks(frames, analysis.summary);
  return (
    <>
      <section className="result-hero">
        <div>
          <p className="eyebrow">POSE ESTIMATE</p>
          <h2>Release frame found.</h2>
          <p>
            ShotLab used wrist rise and arm extension to find the likely release. Drag the frame control if the ball leaves your hand earlier or later.
          </p>
        </div>
        <div className="confidence-ring">
          <strong>{Math.round((analysis.metrics.confidence ?? 0) * 100)}%</strong>
          <span>pose quality</span>
        </div>
      </section>

      <section className="release-control card-panel">
        <div className="release-control-head">
          <span><Play size={16} /> Release estimate</span>
          <b>{releaseFrame ? `${roundMetric(releaseFrame.timestampMs / 1000, 2)}s` : "—"}</b>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={releaseFrameIndex}
          onChange={(event) => onReleaseFrameChange(Number(event.target.value))}
          aria-label="Correct the release frame"
        />
        <div className="release-ticks" style={{ height: `${(releaseMarks[0]?.lanes ?? 1) * 18}px` }}>
          {releaseMarks.map((mark) => (
            <span
              key={mark.key}
              style={{
                left: `${mark.percent}%`,
                top: `${mark.lane * 18}px`,
                transform: mark.percent <= 8 ? "translateX(0)" : mark.percent >= 92 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {mark.label}
            </span>
          ))}
        </div>
      </section>

      <section>
        <SectionHeading eyebrow="THIS REP" title="Form snapshot" />
        <MetricGrid metrics={analysis.metrics} />
      </section>

      <section className="comparison-card card-panel">
        <SectionHeading eyebrow="PERSONAL BASELINE" title="Compare to your makes" />
        {history.filter((shot) => shot.result === "made").length ? (
          <div className="comparison-table">
            <div className="comparison-row header"><span>Metric</span><span>This shot</span><span>Makes avg</span></div>
            {comparisons.map((comparison) => (
              <div className="comparison-row" key={comparison.key}>
                <span>{comparison.label}</span>
                <b>{formatComparisonValue(comparison.current, comparison.unit)}</b>
                <span>{formatComparisonValue(comparison.made.mean, comparison.unit)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="comparison-empty">Mark a few makes to turn this table into your own baseline.</p>
        )}
      </section>

      <aside className="accuracy-note">
        <ShieldCheck size={20} />
        <p><b>Useful, not laboratory 3D.</b> Angles and relative movement are repeatable when the phone stays fixed. Drift is shown in shoulder-width units, not fake centimeters.</p>
      </aside>
    </>
  );
}

function AnalyzeScreen({
  phase,
  file,
  videoUrl,
  videoRef,
  settings,
  analysis,
  frames,
  history,
  outcome,
  notes,
  progress,
  progressLabel,
  releaseFrameIndex,
  error,
  saving,
  onPick,
  onReset,
  onAnalyze,
  onOutcome,
  onNotes,
  onReleaseFrame,
  onSave,
  onCancel,
}: {
  phase: AnalyzePhase;
  file: File | null;
  videoUrl: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  settings: ShotLabSettings;
  analysis: AnalysisResult | null;
  frames: PoseFrame[];
  history: ShotRecord[];
  outcome: ShotResult;
  notes: string;
  progress: number;
  progressLabel: string;
  releaseFrameIndex: number;
  error: string | null;
  saving: boolean;
  onPick(file: File): void;
  onReset(): void;
  onAnalyze(): void;
  onOutcome(value: ShotResult): void;
  onNotes(value: string): void;
  onReleaseFrame(index: number): void;
  onSave(): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="screen-content analyze-screen">
      <SectionHeading
        eyebrow="ON-DEVICE ANALYSIS"
        title={phase === "pick" ? "Film one clean rep." : phase === "result" ? "Review the evidence." : "Prepare the clip."}
        titleLevel="h1"
        action={phase !== "pick" ? <button className="text-button" type="button" onClick={onReset} disabled={saving}><RotateCcw size={15} /> Start over</button> : null}
      />

      {phase === "pick" ? (
        <>
          <label
            className="video-dropzone"
            onDragOver={(event) => {
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer?.files?.[0];
              if (dropped) onPick(dropped);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              onChange={(event) => {
                const input = event.currentTarget;
                const selected = input.files?.[0];
                input.value = "";
                if (selected) onPick(selected);
              }}
            />
            <span className="dropzone-orbit"><Camera size={31} /></span>
            <p className="eyebrow">NEW SHOT CLIP</p>
            <h2>Record or choose a video.</h2>
            <p>One shot per clip works best for this first version.</p>
            <span className="primary-button"><Upload size={18} /> Choose video</span>
            <small><LockKeyhole size={13} /> Pose analysis stays on this device.</small>
          </label>
          {error ? <div className="inline-error"><CircleX size={18} /> {error}</div> : null}
          <SetupChecklist />
        </>
      ) : null}

      {videoUrl && file && phase !== "pick" ? (
        <>
          <section className="video-stage">
            <video ref={videoRef} src={videoUrl} controls playsInline preload="metadata">
              <track kind="captions" src="empty.vtt" srcLang="en" label="No dialogue" />
            </video>
            {settings.showPoseOverlay && analysis ? (
              <PoseOverlay
                frame={frames[releaseFrameIndex]}
                activeSide={analysis.metrics.dominantSide === "left" ? "left" : "right"}
                videoRef={videoRef}
                releaseTimestampMs={frames[releaseFrameIndex]?.timestampMs}
              />
            ) : null}
            <div className="video-stage-label"><span>{file.name}</span><b>{formatFileSize(file.size)}</b></div>
          </section>

          {phase === "ready" ? (
            <section className="ready-panel card-panel">
              <div>
                <span className="ready-icon"><Zap size={21} /></span>
                <div><h3>Ready for pose tracking</h3><p>About {settings.analysisFps} frames per second, capped for phone performance.</p></div>
              </div>
              <button className="primary-button" type="button" onClick={onAnalyze}><Activity size={18} /> Analyze form</button>
            </section>
          ) : null}

          {phase === "running" ? (
            <div className="analysis-progress card-panel">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.max(0, Math.min(100, Math.round(progress)))}
                aria-label={progressLabel}
              >
                <div className="progress-top"><span><LoaderCircle className="spin" size={20} /> {progressLabel}</span><strong>{progress}%</strong></div>
                <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
              </div>
              <p>Keep ShotLab open while this clip is analyzed. Pose data stays on this device. Cancel, or leave this screen, to stop.</p>
              <button className="text-button" type="button" onClick={onCancel}>Cancel analysis</button>
            </div>
          ) : null}

          {error ? <div className="inline-error"><CircleX size={18} /> {error}</div> : null}

          {phase === "result" && analysis ? (
            <>
              <AnalysisResults
                analysis={analysis}
                frames={frames}
                history={history}
                releaseFrameIndex={releaseFrameIndex}
                onReleaseFrameChange={onReleaseFrame}
              />
              <section className="save-shot-panel card-panel">
                <div>
                  <p className="eyebrow">LABEL THE REP</p>
                  <h3>What happened?</h3>
                  <p>This is what turns your own shots into the coaching dataset.</p>
                </div>
                <OutcomePicker value={outcome} onChange={onOutcome} />
                <label className="notes-field">
                  <span>Quick note <small>optional</small></span>
                  <input value={notes} onChange={(event) => onNotes(event.target.value)} maxLength={180} placeholder="Short, left, tired legs…" />
                </label>
                <button className="primary-button wide" type="button" onClick={onSave} disabled={saving}>
                  {saving ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />} {saving ? "Saving shot" : "Save shot"}
                </button>
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function HistoryClip({ shot }: { shot: ShotRecord }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const aliveRef = useRef(false);
  const hasClip = Boolean(shot.video?.localVideoId || shot.video?.storagePath || shot.video?.downloadUrl);

  useEffect(() => {
    if (!hasClip) return undefined;
    aliveRef.current = true;
    let objectUrl: string | undefined;
    let canceled = false;
    const reveal = (next: string) => {
      if (!canceled) setSrc(next);
    };
    void (async () => {
      try {
        const videos = await localVideoStore.getForShot(shot.id);
        if (canceled) return;
        const blob = videos.find((video) => video.blob.size > 0)?.blob;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          if (canceled) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = undefined;
            return;
          }
          reveal(objectUrl);
          return;
        }
        if (shot.video?.storagePath) {
          try {
            const downloadUrl = await cloudVideoStore.getDownloadUrl(shot.video.storagePath);
            reveal(downloadUrl);
            return;
          } catch (error) {
            if (canceled) return;
            if (shot.video.downloadUrl) {
              reveal(shot.video.downloadUrl);
              return;
            }
            throw error;
          }
        }
        if (shot.video?.downloadUrl) {
          reveal(shot.video.downloadUrl);
          return;
        }
        if (!canceled) setFailed(true);
      } catch {
        if (!canceled) setFailed(true);
      }
    })();
    return () => {
      canceled = true;
      aliveRef.current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasClip, shot.id, shot.video?.downloadUrl, shot.video?.localVideoId, shot.video?.storagePath]);

  if (!hasClip) return null;
  if (failed) return <p className="clip-status" role="status">The clip is saved, but it could not be opened on this device.</p>;
  if (!src) return <p className="clip-status" role="status">Loading clip.</p>;
  return (
    <section className="video-stage history-clip">
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={shot.capture?.originalFileName ?? "Saved shot clip"}
        onError={() => {
          if (aliveRef.current) setFailed(true);
        }}
      >
        <track kind="captions" src="empty.vtt" srcLang="en" label="No dialogue" />
      </video>
    </section>
  );
}

function HistoryScreen({
  shots,
  selected,
  onSelect,
  onDelete,
}: {
  shots: ShotRecord[];
  selected: ShotRecord | null;
  onSelect(shot: ShotRecord | null): void;
  onDelete(shot: ShotRecord): void;
}) {
  const [filter, setFilter] = useState<"all" | "made" | "missed">("all");
  const visible = shots.filter((shot) => filter === "all" || shot.result === filter);
  const insight = deriveCoachingInsight(shots);
  const comparison = compareOutcomes(shots);

  if (selected) {
    return (
      <div className="screen-content history-detail">
        <button className="back-button" type="button" onClick={() => onSelect(null)}><ArrowLeft size={17} /> History</button>
        <div className="detail-head">
          <div><ResultBadge result={selected.result} /><h1>{formatDate(selected.recordedAt)}</h1><p>{selected.capture?.originalFileName ?? "Shot clip"}</p></div>
          <button className="icon-button danger" type="button" onClick={() => onDelete(selected)} aria-label="Delete shot"><Trash2 size={18} /></button>
        </div>
        <HistoryClip
          key={`${selected.id}:${selected.video?.localVideoId ?? ""}:${selected.video?.storagePath ?? ""}:${selected.video?.downloadUrl ?? ""}`}
          shot={selected}
        />
        <MetricGrid metrics={selected.metrics} />
        {selected.notes ? <blockquote className="shot-note">“{selected.notes}”</blockquote> : null}
        <section className="card-panel detail-meta">
          <div><span>Analysis</span><b>{selected.poseSummary?.modelVersion ?? "Pose Landmarker Lite"}</b></div>
          <div><span>Frames measured</span><b>{selected.poseSummary?.frameCount ?? "—"}</b></div>
          <div><span>Storage</span><b>{selected.video?.storagePath ? "Video in cloud" : selected.video?.localVideoId ? "Video on device" : "Metrics only"}</b></div>
          <div><span>Sync</span><b>{selected.sync.status.replace("-", " ")}</b></div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen-content history-screen">
      <SectionHeading eyebrow="PERSONAL DATASET" title="Shot history" titleLevel="h1" />
      <section className="insight-card history-insight">
        <div className="insight-icon"><BarChart3 size={20} /></div>
        <div><p className="eyebrow">STRONGEST SIGNAL</p><h3>{insight.title}</h3><p>{insight.detail}</p></div>
      </section>

      <div className="segmented-control" role="group" aria-label="Filter shot history">
        {(["all", "made", "missed"] as const).map((value) => (
          <button key={value} className={filter === value ? "selected" : ""} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === "all" ? `All ${shots.length}` : value === "made" ? `Makes ${shots.filter((shot) => shot.result === "made").length}` : `Misses ${shots.filter((shot) => shot.result === "missed").length}`}
          </button>
        ))}
      </div>

      {visible.length ? (
        <div className="history-list">
          {visible.map((shot) => {
            const place = shots.findIndex((item) => item.id === shot.id);
            const number = place >= 0 ? shots.length - place : 0;
            return (
              <button className="history-row" type="button" key={shot.id} onClick={() => onSelect(shot)}>
                <span className="shot-number">{String(number).padStart(2, "0")}</span>
                <div><ResultBadge result={shot.result} /><small>{formatDate(shot.recordedAt)}</small></div>
                <div className="history-metric"><span>Elbow</span><b>{formatFinite(shot.metrics.elbowAngleDeg, (value) => `${Math.round(value)}°`)}</b></div>
                <div className="history-metric hide-mobile"><span>Knee</span><b>{formatFinite(shot.metrics.kneeAngleDeg, (value) => `${Math.round(value)}°`)}</b></div>
                <div className="history-metric hide-mobile"><span>Drift</span><b>{formatFinite(shot.metrics.jumpDrift, (value) => `${roundMetric(value, 2)}×`)}</b></div>
                <ChevronRight size={18} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-state stacked"><span className="empty-state-icon"><History size={24} /></span><div><h3>No shots in this view.</h3><p>Analyze a clip, then mark it made or missed.</p></div></div>
      )}

      {shots.length ? (
        <section className="card-panel outcome-summary">
          <SectionHeading eyebrow="MAKES VS MISSES" title="Your emerging ranges" />
          <div className="comparison-table">
            <div className="comparison-row header"><span>Metric</span><span>Makes</span><span>Misses</span></div>
            {comparison.map((item) => (
              <div className="comparison-row" key={item.key}>
                <span>{item.label}</span>
                <b>{formatComparisonValue(item.made.mean, item.unit)}</b>
                <span>{formatComparisonValue(item.missed.mean, item.unit)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange(value: boolean): void; label: string; detail: string }) {
  const id = useId();
  return (
    <label className="setting-row toggle-row" htmlFor={id} aria-label={label}>
      <span><b>{label}</b><small>{detail}</small></span>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true"><span /></i>
    </label>
  );
}

function SettingsScreen({
  settings,
  user,
  installPrompt,
  onSettings,
  onSignIn,
  onSignOut,
  onInstall,
}: {
  settings: ShotLabSettings;
  user: ShotLabUser | null;
  installPrompt: InstallPromptEvent | null;
  onSettings(update: Partial<ShotLabSettings>): void;
  onSignIn(): void;
  onSignOut(): void;
  onInstall(): void;
}) {
  return (
    <div className="screen-content settings-screen">
      <SectionHeading eyebrow="CONTROL CENTER" title="ShotLab settings" titleLevel="h1" />

      <section className="account-card card-panel">
        <div className="account-icon">{user ? <Cloud size={23} /> : <CloudOff size={23} />}</div>
        <div><p className="eyebrow">FIREBASE SYNC</p><h3>{user ? user.displayName ?? user.email ?? "Google account" : "Use ShotLab on every screen"}</h3><p>{user ? "Shot summaries stay synced across your phone and laptop." : "Sign in with Google to sync metrics and history. Your raw videos stay local unless you opt in."}</p></div>
        {user ? (
          <button className="secondary-button" type="button" onClick={onSignOut}><LogOut size={16} /> Sign out</button>
        ) : (
          <button className="primary-button" type="button" onClick={onSignIn}><LogIn size={17} /> Connect Google</button>
        )}
      </section>

      <section className="settings-group card-panel">
        <div className="settings-group-title"><Upload size={18} /><div><h3>Video storage</h3><p>Metrics are tiny. Original clips are not.</p></div></div>
        <Toggle checked={settings.autoUploadVideos} onChange={(value) => onSettings({ autoUploadVideos: value })} label="Upload original videos" detail="Off by default. Requires Firebase’s pay-as-you-go Storage plan." />
        <Toggle checked={settings.keepLocalVideos} onChange={(value) => onSettings({ keepLocalVideos: value })} label="Keep clips on this device" detail="Lets you revisit the source without using cloud storage." />
      </section>

      <section className="settings-group card-panel">
        <div className="settings-group-title"><Activity size={18} /><div><h3>Analysis</h3><p>Tune the balance between detail and phone speed.</p></div></div>
        <label className="setting-row select-row" htmlFor="shotlab-shooting-side" aria-label="Shooting side">
          <span><b>Shooting side</b><small>Auto uses the most visible arm.</small></span>
          <select id="shotlab-shooting-side" value={settings.handedness} onChange={(event) => onSettings({ handedness: event.target.value as Handedness })}>
            <option value="unknown">Auto</option><option value="right">Right</option><option value="left">Left</option>
          </select>
        </label>
        <label className="setting-row range-row" htmlFor="shotlab-analysis-rate">
          <span><b>Analysis sample rate</b><small>Higher is more precise but takes longer.</small></span>
          <strong>{settings.analysisFps} fps</strong>
          <input id="shotlab-analysis-rate" type="range" min="10" max="30" step="5" value={settings.analysisFps} onChange={(event) => onSettings({ analysisFps: Number(event.target.value) })} />
        </label>
        <Toggle checked={settings.showPoseOverlay} onChange={(value) => onSettings({ showPoseOverlay: value })} label="Show pose overlay" detail="Draw the measured skeleton over the release frame." />
      </section>

      <section className="settings-group card-panel">
        <div className="settings-group-title"><Download size={18} /><div><h3>Install ShotLab</h3><p>Keep it on your home screen for faster gym access.</p></div></div>
        {installPrompt ? (
          <button className="secondary-button wide" type="button" onClick={onInstall}><Download size={17} /> Add to home screen</button>
        ) : (
          <p className="install-note">On iPhone, open the Share sheet and tap Add to Home Screen. On Android, open the browser menu and choose Install app or Add to Home screen.</p>
        )}
      </section>

      <aside className="privacy-card"><ShieldCheck size={19} /><div><b>Privacy by architecture</b><p>Landmark detection and metric calculation run in your browser. Shot summaries only reach Firebase after you sign in.</p></div></aside>
    </div>
  );
}

export function ShotLabApp() {
  const [screen, setScreen] = useState<Screen>("home");
  const [shots, setShots] = useState<ShotRecord[]>([]);
  const [settings, setSettings] = useState<ShotLabSettings>({
    ...DEFAULT_SHOTLAB_SETTINGS,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  });
  const [user, setUser] = useState<ShotLabUser | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [selectedHistoryShot, setSelectedHistoryShot] = useState<ShotRecord | null>(null);

  const [phase, setPhase] = useState<AnalyzePhase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<PoseFrame[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [releaseFrameIndex, setReleaseFrameIndex] = useState(0);
  const [outcome, setOutcome] = useState<ShotResult>("unknown");
  const [notes, setNotes] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Loading pose model");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const savingRef = useRef(false);
  const syncChainRef = useRef(Promise.resolve());
  const preserveIdsRef = useRef(new Set<string>());
  const preserveOwnerRef = useRef<string | null>(null);
  const shotsRevisionRef = useRef(0);
  const claimRef = useRef(new Map<string, Promise<ShotRecord[]>>());
  const claimedOwnerRef = useRef<string | null>(null);
  const declinedClaimRef = useRef(new Set<string>());
  const claimChoiceRef = useRef<((accept: boolean) => void) | null>(null);
  const claimDialogRef = useRef<HTMLDialogElement>(null);
  const [claimPrompt, setClaimPrompt] = useState<number | null>(null);

  const enqueueSync = useCallback((task: () => Promise<void>) => {
    const run = syncChainRef.current.then(task);
    syncChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const uploadPendingShots = useCallback(async (ownerId: string) => {
    try {
      const ids = await flushPendingShotUploads(ownerId);
      protectShotIds(ids, ownerId, preserveIdsRef.current, preserveOwnerRef);
    } catch (error) {
      if (error instanceof PendingUploadError) {
        protectShotIds(error.syncedIds, ownerId, preserveIdsRef.current, preserveOwnerRef);
      }
      throw error;
    }
  }, []);

  const claimLocalShots = useCallback((uid: string) => {
    const existing = claimRef.current.get(uid);
    if (existing) return existing;
    let resolveList: (shots: ShotRecord[]) => void = () => {};
    let rejectList: (error: unknown) => void = () => {};
    const result = new Promise<ShotRecord[]>((resolve, reject) => {
      resolveList = resolve;
      rejectList = reject;
    });
    claimRef.current.set(uid, result);
    void enqueueSync(async () => {
      try {
        if (claimedOwnerRef.current !== uid) {
          if (preserveOwnerRef.current !== uid) {
            preserveIdsRef.current.clear();
            preserveOwnerRef.current = uid;
          }
          claimedOwnerRef.current = uid;
        }
        const unsigned = await localShotStore.list({ ownerId: "local" });
        if (unsigned.length > 0 && !declinedClaimRef.current.has(uid)) {
          const accepted = await new Promise<boolean>((resolve) => {
            claimChoiceRef.current = resolve;
            setClaimPrompt(unsigned.length);
          });
          if (accepted) {
            shotsRevisionRef.current += 1;
            await reassignLocalOwner("local", uid);
          } else if (claimedOwnerRef.current === uid) {
            declinedClaimRef.current.add(uid);
          }
        }
        resolveList(await localShotStore.list());
      } catch (error) {
        rejectList(error);
      } finally {
        if (claimRef.current.get(uid) === result) claimRef.current.delete(uid);
      }
    });
    return result;
  }, [enqueueSync]);

  const deletionRetryRef = useRef(new Map<string, Promise<void>>());
  const retryCloudDeletions = useCallback((ownerId: string) => {
    const existing = deletionRetryRef.current.get(ownerId);
    if (existing) return existing;
    const pending = flushShotDeletions(ownerId);
    deletionRetryRef.current.set(ownerId, pending);
    void pending.finally(() => {
      if (deletionRetryRef.current.get(ownerId) === pending) deletionRetryRef.current.delete(ownerId);
    }).catch(() => {});
    return pending;
  }, []);

  const refreshLocal = useCallback(async () => {
    const revision = shotsRevisionRef.current;
    const [localShots, localSettings] = await Promise.all([
      localShotStore.list(),
      localSettingsStore.get(),
    ]);
    setSettings(localSettings);
    if (revision === shotsRevisionRef.current) setShots(localShots);
  }, []);

  useEffect(() => {
    const localLoad = window.setTimeout(() => {
      void refreshLocal().catch(() => {
        setNotice({ tone: "warning", text: "Private browsing blocked local storage. ShotLab will work for this tab only." });
      });
    }, 0);
    if ("serviceWorker" in navigator) {
      const serviceWorkerUrl = new URL("sw.js", document.baseURI);
      void navigator.serviceWorker.register(serviceWorkerUrl).catch(() => {});
    }
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    const blockFileNavigation = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      if (!types || ![...types].includes("Files")) return;
      event.preventDefault();
    };
    window.addEventListener("dragenter", blockFileNavigation);
    window.addEventListener("dragover", blockFileNavigation);
    window.addEventListener("drop", blockFileNavigation);
    return () => {
      window.clearTimeout(localLoad);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("dragenter", blockFileNavigation);
      window.removeEventListener("dragover", blockFileNavigation);
      window.removeEventListener("drop", blockFileNavigation);
    };
  }, [refreshLocal]);

  useEffect(() => {
    let authUnsubscribe: (() => void) | undefined;
    let cloudUnsubscribe: (() => void) | undefined;
    let canceled = false;
    let activeOwner: string | undefined;
    let generation = 0;
    const warnSync = () => setNotice({ tone: "warning", text: "Cloud sync is temporarily unavailable. Reconnect to retry." });
    const retry = () => {
      const ownerId = activeOwner;
      if (!ownerId) return;
      void enqueueSync(async () => {
        try {
          if (canceled || activeOwner !== ownerId) return;
          const failures: unknown[] = [];
          try {
            await retryCloudDeletions(ownerId);
          } catch (error) {
            failures.push(error);
          }
          try {
            await uploadPendingShots(ownerId);
          } catch (error) {
            failures.push(error);
          }
          if (canceled || activeOwner !== ownerId) return;
          const revision = shotsRevisionRef.current;
          const listed = await localShotStore.list();
          if (!canceled && activeOwner === ownerId && revision === shotsRevisionRef.current) {
            setShots(listed);
          }
          if (failures.length && !canceled) warnSync();
        } catch {
          if (!canceled) warnSync();
        }
      });
    };
    window.addEventListener("online", retry);
    void firebaseAuth.observe(
      (nextUser) => {
        if (canceled) return;
        const currentGeneration = ++generation;
        cloudUnsubscribe?.();
        cloudUnsubscribe = undefined;
        activeOwner = nextUser?.uid;
        if (!nextUser) {
          claimedOwnerRef.current = null;
          declinedClaimRef.current.clear();
          const resolveClaim = claimChoiceRef.current;
          claimChoiceRef.current = null;
          setClaimPrompt(null);
          resolveClaim?.(false);
          setUser(null);
          setSelectedHistoryShot(null);
          return;
        }
        const uid = nextUser.uid;
        void (async () => {
          let listed: ShotRecord[];
          try {
            listed = await claimLocalShots(uid);
          } catch {
            if (canceled || currentGeneration !== generation) return;
            setUser(nextUser);
            warnSync();
            return;
          }
          if (canceled || currentGeneration !== generation) return;
          setShots(listed);
          setUser(nextUser);
          setSelectedHistoryShot((current) => current ? listed.find((shot) => shot.id === current.id) ?? null : null);
          if (canceled || currentGeneration !== generation) return;
          retry();
          void cloudShotStore.subscribe(
            (snapshot) => {
              void enqueueSync(async () => {
                try {
                  if (canceled || currentGeneration !== generation) return;
                  try {
                    await uploadPendingShots(uid);
                  } catch {
                    if (!canceled && currentGeneration === generation) warnSync();
                  }
                  if (canceled || currentGeneration !== generation) return;
                  const keep = [...preserveIdsRef.current];
                  const reconciled = await localShotStore.reconcileCloud(uid, snapshot, { preserveIds: keep });
                  if (!snapshot.fromCache && !snapshot.hasPendingWrites) {
                    for (const id of keep) {
                      if (snapshot.shots.some((shot) => shot.id === id)) preserveIdsRef.current.delete(id);
                    }
                  }
                  if (canceled || currentGeneration !== generation) return;
                  setShots(reconciled);
                  setSelectedHistoryShot((current) => current ? reconciled.find((shot) => shot.id === current.id) ?? null : null);
                } catch {
                  if (!canceled && currentGeneration === generation) warnSync();
                }
              });
            },
            { onError: warnSync },
          ).then((stop) => {
            if (canceled || currentGeneration !== generation) stop();
            else cloudUnsubscribe = stop;
          }).catch(warnSync);
        })();
      },
      () => {},
    ).then((stop) => {
      if (canceled) stop();
      else authUnsubscribe = stop;
    }).catch(() => {});
    return () => {
      canceled = true;
      generation += 1;
      authUnsubscribe?.();
      cloudUnsubscribe?.();
      window.removeEventListener("online", retry);
    };
  }, [claimLocalShots, enqueueSync, retryCloudDeletions, uploadPendingShots]);

  const finishClaim = useCallback((accept: boolean) => {
    setClaimPrompt(null);
    const resolve = claimChoiceRef.current;
    claimChoiceRef.current = null;
    resolve?.(accept);
  }, []);

  useEffect(() => {
    if (claimPrompt === null) return;
    const dialog = claimDialogRef.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.show();
      }
      dialog.querySelector<HTMLElement>(".claim-dialog-actions .secondary-button")?.focus();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finishClaim(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog?.open) dialog.close();
      window.removeEventListener("keydown", onKey);
    };
  }, [claimPrompt, finishClaim]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    analysisAbortRef.current?.abort();
  }, [videoUrl]);

  const viewerId = user?.uid ?? "local";
  const visibleShots = shotsForViewer(shots, viewerId);
  const selectedVisible =
    selectedHistoryShot && selectedHistoryShot.ownerId === viewerId ? selectedHistoryShot : null;

  const navigate = (next: Screen) => {
    if (next !== "analyze" && analysisAbortRef.current) {
      analysisAbortRef.current.abort();
      setPhase((current) => (current === "running" ? "ready" : current));
      setProgress(0);
      setProgressLabel("Loading pose model");
    }
    setScreen(next);
    if (next !== "history") setSelectedHistoryShot(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelAnalysis = () => {
    analysisAbortRef.current?.abort();
    setPhase((current) => (current === "running" ? "ready" : current));
    setProgress(0);
    setProgressLabel("Loading pose model");
  };

  const resetAnalysis = () => {
    analysisAbortRef.current?.abort();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(null);
    setVideoUrl(null);
    setFrames([]);
    setAnalysis(null);
    setReleaseFrameIndex(0);
    setOutcome("unknown");
    setNotes("");
    setProgress(0);
    setAnalysisError(null);
    setPhase("pick");
  };

  const pickVideo = (selected: File) => {
    if (!isVideoFile(selected)) {
      setAnalysisError("Choose a video file from your camera or library.");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(selected);
    setVideoUrl(URL.createObjectURL(selected));
    setAnalysisError(null);
    setAnalysis(null);
    setFrames([]);
    setPhase("ready");
  };

  const runAnalysis = async () => {
    const video = videoRef.current;
    if (!video || !file) return;
    if (analysisAbortRef.current && !analysisAbortRef.current.signal.aborted) return;
    if (video.readyState < 1) {
      setAnalysisError("Wait a moment for the video to load, then try again.");
      return;
    }
    video.pause();
    setPhase("running");
    setAnalysisError(null);
    setProgress(1);
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    try {
      const output = await analyzeVideoElement(video, {
        targetFps: settings.analysisFps,
        maxFrames: 600,
        maxLongEdge: 720,
        signal: controller.signal,
        onProgress: (state) => {
          if (controller.signal.aborted) return;
          setProgress(state.percent);
          setProgressLabel(
            state.stage === "loading-model"
              ? "Loading pose model"
              : state.stage === "finishing"
                ? "Calculating shot metrics"
                : `Tracking pose · ${state.completedFrames}/${state.totalFrames}`,
          );
        },
      });
      if (controller.signal.aborted) return;
      const measured = analyzePoseFrames(output.frames, {
        preferredSide: settings.handedness,
        history: visibleShots,
      });
      if (controller.signal.aborted) return;
      if ((measured.metrics.confidence ?? 0) < 0.22) {
        throw new Error("ShotLab could not see a full, stable body in enough frames. Try a brighter clip with your feet and release hand visible.");
      }
      const releaseIndex = Math.max(
        0,
        output.frames.findIndex((frame) => frame.frameIndex === measured.summary.releaseFrame),
      );
      if (controller.signal.aborted) return;
      setFrames(output.frames);
      setAnalysis(measured);
      setReleaseFrameIndex(releaseIndex);
      video.currentTime = (output.frames[releaseIndex]?.timestampMs ?? 0) / 1000;
      setPhase("result");
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnalysisError(error instanceof Error ? error.message : "Shot analysis failed.");
      setPhase("ready");
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null;
    }
  };

  const changeReleaseFrame = (index: number) => {
    const safeIndex = Math.max(0, Math.min(frames.length - 1, index));
    const frame = frames[safeIndex];
    if (!frame) return;
    setReleaseFrameIndex(safeIndex);
    setAnalysis(
      analyzePoseFrames(frames, {
        preferredSide: settings.handedness,
        releaseFrameOverride: frame.frameIndex,
        history: visibleShots,
      }),
    );
    if (videoRef.current) videoRef.current.currentTime = frame.timestampMs / 1000;
  };

  const saveCurrentShot = async () => {
    if (savingRef.current || !analysis || !file) return;
    savingRef.current = true;
    setSaving(true);
    const clip = file;
    const measured = analysis;
    let localVideoId: string | undefined;
    let shotSaved = false;
    let shotId = "";
    try {
      const timestamp = new Date().toISOString();
      shotId = newId("shot");
      if (user) protectShotIds([shotId], user.uid, preserveIdsRef.current, preserveOwnerRef);
      const ownerId = user?.uid ?? "local";
      if (settings.keepLocalVideos) {
        const localVideo = await localVideoStore.storeForShot({
          shotId,
          ownerId,
          blob: clip,
          originalFileName: clip.name,
        });
        localVideoId = localVideo.id;
      }
      let shot: ShotRecord = {
        schemaVersion: SHOT_RECORD_SCHEMA_VERSION,
        id: shotId,
        ownerId,
        createdAt: timestamp,
        updatedAt: timestamp,
        recordedAt: timestamp,
        status: "ready",
        result: outcome,
        metrics: measured.metrics,
        poseSummary: measured.summary,
        poseFrames: frames,
        capture: {
          originalFileName: clip.name,
          mimeType: clip.type,
          sizeBytes: clip.size,
          durationMs: videoRef.current ? Math.round(videoRef.current.duration * 1000) : undefined,
          width: videoRef.current?.videoWidth,
          height: videoRef.current?.videoHeight,
          handedness: measured.metrics.dominantSide,
          cameraView: settings.preferredCameraView,
        },
        video: localVideoId
          ? { localVideoId, originalFileName: clip.name, contentType: clip.type, sizeBytes: clip.size }
          : undefined,
        notes: notes.trim() || undefined,
        sync: {
          status: user ? "pending" : "local-only",
          changedAt: timestamp,
        },
      };
      await localShotStore.save(shot);
      shotSaved = true;
      let cloudFailed = false;
      if (user) {
        try {
          shot = await cloudShotStore.save(shot);
          await localShotStore.save(shot);
        } catch {
          cloudFailed = true;
        }
      }
      setShots((current) => mergeShots(current, [shot]));

      let followUp: Notice | null = null;
      if (settings.autoUploadVideos && user && !cloudFailed) {
        try {
          const uploaded = await cloudVideoStore.upload({
            shotId,
            videoId: localVideoId,
            data: clip,
            originalFileName: clip.name,
            contentType: clip.type,
            onProgress: (state) => {
              setNotice({ tone: "success", text: `Uploading original video · ${Math.round(state.progressPct)}%` });
            },
          });
          shot = await localShotStore.update(shotId, {
            video: {
              ...shot.video,
              storagePath: uploaded.storagePath,
              downloadUrl: uploaded.downloadUrl,
              uploadedAt: uploaded.uploadedAt,
            },
          });
          try {
            shot = await cloudShotStore.save(shot);
            await localShotStore.save(shot);
            followUp = { tone: "success", text: "Shot saved. The original video is in cloud storage." };
          } catch {
            shot = await localShotStore.setSyncState(shotId, "pending");
            followUp = { tone: "warning", text: "The video uploaded. The cloud record will retry so other devices can find it." };
          }
          setShots((current) => mergeShots(current, [shot]));
        } catch (error) {
          followUp = { tone: "warning", text: videoUploadFailureMessage(error) };
        }
      } else if (cloudFailed) {
        followUp = { tone: "warning", text: "Saved on this device. Cloud sync will retry when Firebase is available." };
      } else {
        followUp = { tone: "success", text: user ? "Shot saved and synced." : "Shot saved on this device." };
      }
      if (followUp) setNotice(followUp);
      resetAnalysis();
      navigate("home");
    } catch (error) {
      if (!shotSaved) preserveIdsRef.current.delete(shotId);
      if (localVideoId && !shotSaved) {
        await localVideoStore.delete(localVideoId).catch(() => {});
      }
      setNotice({
        tone: "error",
        text: error instanceof Error && error.message ? error.message : "ShotLab could not save this shot.",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const updateAppSettings = async (update: Partial<ShotLabSettings>) => {
    const next = await localSettingsStore.update(update);
    setSettings(next);
  };

  const signIn = async () => {
    try {
      const result = await firebaseAuth.signInWithGoogle();
      let listed: ShotRecord[];
      try {
        listed = await claimLocalShots(result.user.uid);
      } catch (error) {
        await firebaseAuth.signOut().catch(() => {});
        setUser(null);
        setNotice({
          tone: "error",
          text: error instanceof Error && error.message
            ? error.message
            : "ShotLab could not move local shots onto this account.",
        });
        return;
      }
      setShots(listed);
      setUser(result.user);
      try {
        await enqueueSync(async () => {
          try {
            await uploadPendingShots(result.user.uid);
          } finally {
            const revision = shotsRevisionRef.current;
            const refreshed = await localShotStore.list();
            if (revision === shotsRevisionRef.current) setShots(refreshed);
          }
        });
        const unsignedLeft = listed.some((shot) => shot.ownerId === "local");
        setNotice({
          tone: "success",
          text: unsignedLeft
            ? "Signed in. Unsigned shots stayed on this device."
            : "Firebase sync is connected.",
        });
      } catch {
        setNotice({ tone: "warning", text: "Signed in on this device. Some shots will sync when Firebase is available." });
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Google sign-in did not finish." });
    }
  };

  const signOut = async () => {
    await firebaseAuth.signOut();
    setUser(null);
    setSelectedHistoryShot(null);
    setNotice({ tone: "success", text: "Signed out. Account shots show again when you sign in. Unsigned shots stay visible." });
  };

  const deleteHistoryShot = async (shot: ShotRecord) => {
    const message = shot.ownerId === "local"
      ? "Delete this shot and its video from this device?"
      : "Delete this shot and its video from this device and your synced history?";
    if (!window.confirm(message)) return;
    await localShotStore.delete(shot.id);
    setShots((current) => current.filter((item) => item.id !== shot.id));
    setSelectedHistoryShot(null);
    setNotice({ tone: "success", text: "Shot removed from your history." });
    if (user && shot.ownerId === user.uid) {
      try {
        await enqueueSync(() => retryCloudDeletions(user.uid).then(() => undefined));
      } catch {
        setNotice({ tone: "warning", text: "Shot removed on this device. Cloud deletion will retry when you reconnect." });
      }
    }
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const screenNode = (() => {
    if (screen === "analyze") {
      return (
        <AnalyzeScreen
          phase={phase}
          file={file}
          videoUrl={videoUrl}
          videoRef={videoRef}
          settings={settings}
          analysis={analysis}
          frames={frames}
          history={visibleShots}
          outcome={outcome}
          notes={notes}
          progress={progress}
          progressLabel={progressLabel}
          releaseFrameIndex={releaseFrameIndex}
          error={analysisError}
          saving={saving}
          onPick={pickVideo}
          onReset={resetAnalysis}
          onAnalyze={() => void runAnalysis()}
          onOutcome={setOutcome}
          onNotes={setNotes}
          onReleaseFrame={changeReleaseFrame}
          onSave={() => void saveCurrentShot()}
          onCancel={cancelAnalysis}
        />
      );
    }
    if (screen === "history") {
      return (
        <HistoryScreen
          shots={visibleShots}
          selected={selectedVisible}
          onSelect={setSelectedHistoryShot}
          onDelete={(shot) => void deleteHistoryShot(shot)}
        />
      );
    }
    if (screen === "settings") {
      return (
        <SettingsScreen
          settings={settings}
          user={user}
          installPrompt={installPrompt}
          onSettings={(update) => void updateAppSettings(update)}
          onSignIn={() => void signIn()}
          onSignOut={() => void signOut()}
          onInstall={() => void install()}
        />
      );
    }
    return (
      <HomeScreen
        shots={visibleShots}
        user={user}
        onAnalyze={() => navigate("analyze")}
        onHistory={(shot) => {
          setSelectedHistoryShot(shot ?? null);
          navigate("history");
        }}
      />
    );
  })();

  return (
    <div className="shotlab-app">
      <aside className="desktop-sidebar">
        <Brand />
        <button className="sidebar-new-button" type="button" onClick={() => navigate("analyze")}><Plus size={18} /> New analysis</button>
        <nav aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const current = screen === item.id;
            return <button key={item.id} className={current ? "active" : ""} type="button" aria-current={current ? "page" : undefined} onClick={() => navigate(item.id)}><Icon size={19} /> {item.label}</button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-ai-note"><ShieldCheck size={17} /><span><b>On-device vision</b><small>Pose frames stay private.</small></span></div>
          <div className="sidebar-status-row">
            <StatusPill user={user} />
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="mobile-header">
          <Brand />
          <div className="mobile-header-actions">
            <StatusPill user={user} compact />
            <ThemeToggle compact />
          </div>
        </header>
        <main>{screenNode}</main>
      </div>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const current = screen === item.id;
          return <button key={item.id} className={current ? "active" : ""} type="button" aria-current={current ? "page" : undefined} onClick={() => navigate(item.id)}><Icon size={20} /><span>{item.label}</span></button>;
        })}
      </nav>

      {claimPrompt !== null ? (
        <dialog
          ref={claimDialogRef}
          className="claim-dialog"
          aria-labelledby="claim-title"
          aria-describedby="claim-description"
          onCancel={(event) => {
            event.preventDefault();
            finishClaim(false);
          }}
        >
          <div className="claim-dialog-card">
            <h2 id="claim-title">Move shots to this account?</h2>
            <p id="claim-description">
              {claimPrompt === 1 ? "1 shot saved on this device is still unsigned." : `${claimPrompt} shots saved on this device are still unsigned.`} Moving them uploads the makes, misses, notes, and file names to the Google account you just opened. Leaving them here keeps that history off the account. Unsigned shots stay hidden while you are signed in, and show again after you sign out.
            </p>
            <div className="claim-dialog-actions">
              <button className="secondary-button" type="button" onClick={() => finishClaim(false)}>Leave on this device</button>
              <button className="primary-button" type="button" onClick={() => finishClaim(true)}>Move to this account</button>
            </div>
          </div>
        </dialog>
      ) : null}

      {notice ? (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.tone === "success" ? <CircleCheck size={18} /> : notice.tone === "error" ? <CircleX size={18} /> : <CloudOff size={18} />}
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}
