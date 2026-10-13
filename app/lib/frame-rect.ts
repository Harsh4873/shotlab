export interface ContainedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** object-fit: contain. Landmark x/y are normalized to the source frame, not the stage. */
export function containedObjectRect(
  boxWidth: number,
  boxHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ContainedRect {
  if (!(boxWidth > 0) || !(boxHeight > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  }
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (boxWidth - width) / 2,
    y: (boxHeight - height) / 2,
    width,
    height,
  };
}
