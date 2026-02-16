export type CornerRadii = [number, number, number, number];

export function buildRoundedRectPath(width: number, height: number, radii: CornerRadii): string {
  const [rtl, rtr, rbr, rbl] = radii.map((radius) => Math.max(0, radius));
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);

  const tl = Math.min(rtl, safeWidth / 2, safeHeight / 2);
  const tr = Math.min(rtr, safeWidth / 2, safeHeight / 2);
  const br = Math.min(rbr, safeWidth / 2, safeHeight / 2);
  const bl = Math.min(rbl, safeWidth / 2, safeHeight / 2);

  return [
    `M ${tl} 0`,
    `H ${safeWidth - tr}`,
    tr > 0 ? `A ${tr} ${tr} 0 0 1 ${safeWidth} ${tr}` : `L ${safeWidth} 0`,
    `V ${safeHeight - br}`,
    br > 0 ? `A ${br} ${br} 0 0 1 ${safeWidth - br} ${safeHeight}` : `L ${safeWidth} ${safeHeight}`,
    `H ${bl}`,
    bl > 0 ? `A ${bl} ${bl} 0 0 1 0 ${safeHeight - bl}` : `L 0 ${safeHeight}`,
    `V ${tl}`,
    tl > 0 ? `A ${tl} ${tl} 0 0 1 ${tl} 0` : "L 0 0",
    "Z"
  ].join(" ");
}
