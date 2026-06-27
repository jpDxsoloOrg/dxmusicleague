import type { Track } from "../music";
import "./TrackArt.css";

// Album art with a deterministic gradient fallback when a provider gives no artwork
// (the mock catalog has none; Spotify will supply real artworkUrl).
const GRADIENTS = [
  "linear-gradient(135deg,#e83cff,#6d28d9)",
  "linear-gradient(135deg,#7c3aed,#2563eb)",
  "linear-gradient(135deg,#ec4899,#8b2fe0)",
  "linear-gradient(135deg,#22d3ee,#7c3aed)",
  "linear-gradient(135deg,#f59e0b,#e83cff)",
];

function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

export function TrackArt({ track, size = 48 }: { track: Track; size?: number }) {
  const style = { width: size, height: size, borderRadius: Math.max(8, size * 0.16) };
  if (track.artworkUrl) {
    return <img className="track-art" style={style} src={track.artworkUrl} alt="" />;
  }
  return (
    <span className="track-art track-art-fallback" style={{ ...style, background: gradientFor(track.id) }} aria-hidden>
      <span className="note" />
    </span>
  );
}
