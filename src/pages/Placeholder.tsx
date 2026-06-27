// Stand-in for screens not built yet, so navigation works end-to-end.
export function Placeholder({ title }: { title: string }) {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <h2 style={{ fontSize: 24 }}>{title}</h2>
      <p style={{ color: "var(--text-muted)" }}>
        This screen is coming next. Designed in Stitch, not yet built.
      </p>
    </div>
  );
}
