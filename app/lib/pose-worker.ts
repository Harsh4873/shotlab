/// <reference lib="webworker" />

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerOptions,
} from "@mediapipe/tasks-vision";

interface InitMessage {
  id: number;
  type: "init";
  modelUrl: string;
  wasmBaseUrl: string;
}

interface AnalyzeMessage {
  id: number;
  type: "analyze";
  bitmap: ImageBitmap;
  frameIndex: number;
  timestampMs: number;
}

interface CloseMessage {
  id: number;
  type: "close";
}

type RequestMessage = InitMessage | AnalyzeMessage | CloseMessage;

let landmarker: PoseLandmarker | undefined;
let activeDelegate: "GPU" | "CPU" = "CPU";

function send(id: number, payload: Record<string, unknown>) {
  self.postMessage({ id, ...payload });
}

async function createLandmarker(
  wasmBaseUrl: string,
  modelUrl: string,
  delegate: "GPU" | "CPU",
) {
  const vision = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
  const options: PoseLandmarkerOptions = {
    baseOptions: {
      modelAssetPath: modelUrl,
      delegate,
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  };
  if (delegate === "GPU" && typeof OffscreenCanvas !== "undefined") {
    options.canvas = new OffscreenCanvas(1, 1);
  }
  return PoseLandmarker.createFromOptions(vision, options);
}

async function initialize(message: InitMessage) {
  landmarker?.close();
  landmarker = undefined;
  try {
    landmarker = await createLandmarker(
      message.wasmBaseUrl,
      message.modelUrl,
      "GPU",
    );
    activeDelegate = "GPU";
  } catch {
    landmarker = await createLandmarker(
      message.wasmBaseUrl,
      message.modelUrl,
      "CPU",
    );
    activeDelegate = "CPU";
  }
  send(message.id, { type: "ready", delegate: activeDelegate });
}

function analyze(message: AnalyzeMessage) {
  if (!landmarker) throw new Error("Pose engine is not ready.");
  try {
    const result = landmarker.detectForVideo(message.bitmap, message.timestampMs);
    const landmarks = (result.landmarks[0] ?? []).map((landmark, index) => ({
      index,
      x: landmark.x,
      y: landmark.y,
      z: landmark.z,
      visibility: landmark.visibility,
    }));
    const worldLandmarks = (result.worldLandmarks[0] ?? []).map(
      (landmark, index) => ({
        index,
        x: landmark.x,
        y: landmark.y,
        z: landmark.z,
        visibility: landmark.visibility,
      }),
    );
    const confidence = landmarks.length
      ? landmarks.reduce(
          (sum, landmark) => sum + (landmark.visibility ?? 0),
          0,
        ) / landmarks.length
      : 0;
    send(message.id, {
      type: "result",
      frame: {
        frameIndex: message.frameIndex,
        timestampMs: message.timestampMs,
        landmarks,
        worldLandmarks,
        poseConfidence: confidence,
      },
    });
  } finally {
    message.bitmap.close();
  }
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await initialize(message);
      return;
    }
    if (message.type === "analyze") {
      analyze(message);
      return;
    }
    landmarker?.close();
    landmarker = undefined;
    send(message.id, { type: "closed" });
  } catch (error) {
    if (message.type === "analyze") message.bitmap.close();
    send(message.id, {
      type: "error",
      error: error instanceof Error ? error.message : "Pose analysis failed.",
    });
  }
};

export {};
