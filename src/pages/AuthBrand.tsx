// Brand lockup shared by the three auth screens — gradient "DX" mark + name,
// matching the Stitch auth designs and the sidebar brand in AppLayout.

export function AuthBrand() {
  return (
    <div className="auth-brand">
      <span className="auth-brand-mark grad-text">DX</span>
      <span className="auth-brand-name">DX Music League</span>
    </div>
  );
}
