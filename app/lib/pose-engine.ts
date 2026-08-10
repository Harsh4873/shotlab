import type { PoseFrame } from "./types";

interface WorkerResponse {
  id: number;
  type: "ready" | "result" | "closed" | "error";
  delegate?: "GPU" | "CPU";
  frame?: PoseFrame;
  error?: string;
}

interface PendingRequest {
  resolve(value: WorkerResponse): void;
  reject(error: Error): void;
}

export interface VideoAnalysisProgress {
  completedFrames: number;
  totalFrames: number;
  percent: number;
  stage: "loading-model" | "analyzing" | "finishing";
  delegate?: "GPU" | "CPU";
}

export interface VideoAnalysisOptions {
  targetFps?: number;
  maxFrames?: number;
  maxLongEdge?: number;
  signal?: AbortSignal;
  onProgress?(progress: VideoAnalysisProgress): void;
}

export interface VideoAnalysisOutput {
  frames: PoseFrame[];
  sampledFps: number;
  delegate: "GPU" | "CPU";
}

class PoseWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker = new Worker(new URL("./pose-worker.ts", import.meta.url), {
      type: "module",
      name: "shotlab-pose",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.type === "error") {
        request.reject(new Error(response.error ?? "Pose analysis failed."));
      } else {
        request.resolve(response);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "The pose worker stopped unexpectedly.");
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    };
  }

  private request(
    message: Record<string, unknown>,
    transfer: Transferable[] = [],
  ) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  async initialize(modelUrl: string, wasmBaseUrl: string) {
    const response = await this.request({
      type: "init",
      modelUrl,
      wasmBaseUrl,
    });
    return response.delegate ?? "CPU";
  }

  async analyzeFrame(bitmap: ImageBitmap, frameIndex: number, timestampMs: number) {
    const response = await this.request(
      { type: "analyze", bitmap, frameIndex, timestampMs },
      [bitmap],
    );
    if (!response.frame) throw new Error("The pose engine returned an empty frame.");
    return response.frame;
  }

  terminate() {
    this.worker.terminate();
    this.pending.forEach(({ reject }) =>
      reject(new Error("Pose analysis was canceled.")),
    );
    this.pending.clear();
  }
}

function abortError() {
  return new DOMException("Analysis canceled.", "AbortError");
}

function waitForSeek(video: HTMLVideoElement, seconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (Math.abs(video.currentTime - seconds) < 0.002 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The browser could not decode this part of the video."));
    }, 12_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("This video could not be decoded."));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.currentTime = seconds;
  });
}

async function bitmapFromVideo(
  video: HTMLVideoElement,
  maxLongEdge: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("The video dimensions are not available yet.");
  }
  const scale = Math.min(1, maxLongEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  try {
    return await createImageBitmap(video, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "medium",
    });
  } catch {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The browser could not prepare a video frame.");
    context.drawImage(video, 0, 0, width, height);
    return createImageBitmap(canvas);
  }
}

function assetUrl(path: string) {
  return new URL(path.replace(/^\//, ""), `${window.location.origin}/`).href;
}

export async function analyzeVideoElement(
  video: HTMLVideoElement,
  options: VideoAnalysisOptions = {},
): Promise<VideoAnalysisOutput> {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ShotLab could not read this video’s duration.");
  }

  const maxFrames = options.maxFrames ?? 600;
  const requestedFps = options.targetFps ?? 20;
  const sampledFps = Math.max(4, Math.min(requestedFps, maxFrames / duration));
  const intervalSeconds = 1 / sampledFps;
  const sampleTimes: number[] = [];
  const lastTime = Math.max(0, duration - 0.002);
  for (let seconds = 0; seconds < duration; seconds += intervalSeconds) {
    sampleTimes.push(Math.min(seconds, lastTime));
  }
  if (sampleTimes.at(-1) !== lastTime) sampleTimes.push(lastTime);

  const client = new PoseWorkerClient();
  let delegate: "GPU" | "CPU" = "CPU";
  options.onProgress?.({
    completedFrames: 0,
    totalFrames: sampleTimes.length,
    percent: 2,
    stage: "loading-model",
  });

  try {
    delegate = await client.initialize(
      assetUrl("/models/pose_landmarker_lite.task"),
      assetUrl("/mediapipe/wasm"),
    );
    const frames: PoseFrame[] = [];
    for (let index = 0; index < sampleTimes.length; index += 1) {
      if (options.signal?.aborted) throw abortError();
      const seconds = sampleTimes[index];
      await waitForSeek(video, seconds, options.signal);
      const bitmap = await bitmapFromVideo(video, options.maxLongEdge ?? 720);
      const frame = await client.analyzeFrame(bitmap, index, Math.round(seconds * 1000));
      frames.push(frame);
      const completedFrames = index + 1;
      options.onProgress?.({
        completedFrames,
        totalFrames: sampleTimes.length,
        percent: Math.round(8 + (completedFrames / sampleTimes.length) * 88),
        stage: "analyzing",
        delegate,
      });
    }
    options.onProgress?.({
      completedFrames: sampleTimes.length,
      totalFrames: sampleTimes.length,
      percent: 100,
      stage: "finishing",
      delegate,
    });
    return { frames, sampledFps, delegate };
  } finally {
    client.terminate();
  }
}
