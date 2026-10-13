"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

import { containedObjectRect } from "../lib/frame-rect";
import type { PoseFrame } from "../lib/types";

const CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
];

const RELEASE_OVERLAY_TOLERANCE_MS = 150;

interface PoseOverlayProps {
  frame?: PoseFrame;
  activeSide?: "left" | "right";
  videoRef?: RefObject<HTMLVideoElement | null>;
  releaseTimestampMs?: number;
}

export function PoseOverlay({
  frame,
  activeSide = "right",
  videoRef,
  releaseTimestampMs,
}: PoseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);

      const video = videoRef?.current ?? null;
      const away =
        video !== null &&
        releaseTimestampMs !== undefined &&
        Math.abs(video.currentTime * 1000 - releaseTimestampMs) > RELEASE_OVERLAY_TOLERANCE_MS;
      canvas.style.visibility = away ? "hidden" : "visible";
      if (away || !frame?.landmarks.length) return;

      const fitted = containedObjectRect(
        bounds.width,
        bounds.height,
        video?.videoWidth ?? 0,
        video?.videoHeight ?? 0,
      );
      const pointX = (normalized: number) => fitted.x + normalized * fitted.width;
      const pointY = (normalized: number) => fitted.y + normalized * fitted.height;

      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = Math.max(2.5, bounds.width / 170);
      for (const [startIndex, endIndex] of CONNECTIONS) {
        const start = frame.landmarks[startIndex];
        const end = frame.landmarks[endIndex];
        if (!start || !end || (start.visibility ?? 1) < 0.35 || (end.visibility ?? 1) < 0.35) {
          continue;
        }
        const active =
          activeSide === "left"
            ? [11, 13, 15, 23, 25, 27, 29, 31].includes(startIndex) ||
              [11, 13, 15, 23, 25, 27, 29, 31].includes(endIndex)
            : [12, 14, 16, 24, 26, 28, 30, 32].includes(startIndex) ||
              [12, 14, 16, 24, 26, 28, 30, 32].includes(endIndex);
        context.strokeStyle = active ? "rgba(255, 111, 35, .95)" : "rgba(235, 244, 239, .72)";
        context.beginPath();
        context.moveTo(pointX(start.x), pointY(start.y));
        context.lineTo(pointX(end.x), pointY(end.y));
        context.stroke();
      }

      frame.landmarks.forEach((landmark, index) => {
        if (index < 11 || (landmark.visibility ?? 1) < 0.35) return;
        const radius = index === 15 || index === 16 ? 5 : 3.4;
        context.fillStyle = "#f6fbf7";
        context.strokeStyle = "rgba(8, 12, 14, .8)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(pointX(landmark.x), pointY(landmark.y), radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    const video = videoRef?.current;
    video?.addEventListener("timeupdate", draw);
    video?.addEventListener("seeked", draw);
    video?.addEventListener("loadedmetadata", draw);
    return () => {
      observer.disconnect();
      video?.removeEventListener("timeupdate", draw);
      video?.removeEventListener("seeked", draw);
      video?.removeEventListener("loadedmetadata", draw);
    };
  }, [activeSide, frame, releaseTimestampMs, videoRef]);

  return <canvas ref={canvasRef} className="pose-overlay" aria-hidden="true" />;
}
