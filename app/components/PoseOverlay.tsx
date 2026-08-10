"use client";

import { useEffect, useRef } from "react";

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

interface PoseOverlayProps {
  frame?: PoseFrame;
  activeSide?: "left" | "right";
}

export function PoseOverlay({ frame, activeSide = "right" }: PoseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(pixelRatio, pixelRatio);
      context.clearRect(0, 0, bounds.width, bounds.height);
      if (!frame?.landmarks.length) return;

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
        context.moveTo(start.x * bounds.width, start.y * bounds.height);
        context.lineTo(end.x * bounds.width, end.y * bounds.height);
        context.stroke();
      }

      frame.landmarks.forEach((landmark, index) => {
        if (index < 11 || (landmark.visibility ?? 1) < 0.35) return;
        const radius = index === 15 || index === 16 ? 5 : 3.4;
        context.fillStyle = "#f6fbf7";
        context.strokeStyle = "rgba(8, 12, 14, .8)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(
          landmark.x * bounds.width,
          landmark.y * bounds.height,
          radius,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.stroke();
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [activeSide, frame]);

  return <canvas ref={canvasRef} className="pose-overlay" aria-hidden="true" />;
}
