import "./Avatar.css";

interface AvatarProps {
  name: string;
  src?: string;
  size?: number;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Round avatar; falls back to gradient initials when there's no image. */
export function Avatar({ name, src, size = 32 }: AvatarProps) {
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (src) {
    return <img className="avatar" style={style} src={src} alt={name} />;
  }
  return (
    <span className="avatar avatar-initials" style={style} title={name}>
      {initials(name)}
    </span>
  );
}
