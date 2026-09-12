# Security and accessibility

Owner: Security and frontend platform. Related modules:
[audit](06-audit.md), [files](04-sftp-and-files.md).

## 9. Security and privacy

- TLS 1.2 or newer is required at the reverse proxy. HTTP redirects to HTTPS.
- Apply HSTS in production, a restrictive Content Security Policy, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and a strict referrer policy.
- Permit browser API access only from the configured same-origin frontend. Do not use wildcard CORS with credentials.
- Validate request bodies with strict Pydantic models; reject unknown security-sensitive fields.
- Normalize and authorize all file paths on the server. Treat filenames, remote metadata, error text, and audit metadata as untrusted output.
- Escape rendered values and CSV formula prefixes. Never render remote filenames as HTML.
- Encrypt SFTP credentials before storing them in SQLite using an externally supplied key. Do not persist that key in the database, image, or source tree.
- Redact secrets by field name and value fingerprint from structured logs and exception reporting.
- Use constant-time comparison for tokens and credential-verification artifacts where applicable.
- Cap request body sizes before parsing and enforce per-user transfer concurrency.
- The default maximum upload is 2 GiB, configurable from 1 MiB to 20 GiB.
- Default limits are 2 concurrent transfers per user, 10 globally, 10-second connection timeout, 60-second metadata-operation timeout, and 30-minute transfer timeout.
- Canonical paths are limited to 1,024 UTF-8 bytes and individual names to 255 UTF-8 bytes, subject to stricter remote limits.
- Dependency and container-image vulnerability scans must run in CI. Critical known vulnerabilities block release unless formally accepted.

## 10. Accessibility and visual design

- Meet WCAG 2.1 AA for login, signup, dashboard, explorer, task actions, administration, and audit workflows.
- All functionality must be keyboard operable with visible focus indicators and logical focus order.
- Icon-only controls require accessible names. Status must not be communicated by color alone.
- Application actions use MUI Material Symbol components. Buttons and icon buttons use consistent rounded, elevated light surfaces; hover provides a short lift and scale treatment that remains restrained enough to avoid layout movement, while keyboard focus remains visibly outlined. Hover and press transforms are disabled when the user requests reduced motion.
- Adjacent icon-action groups reserve a visible gap and may wrap at constrained widths or browser zoom levels, so hover magnification never overlaps another control or hides its focus/target surface.
- Tables provide proper headers and accessible sorting state. Dialogs trap focus and return it to the invoking control.
- Upload progress and task state changes use polite live regions. Background-upload minimize/expand, per-file pause/resume/retry/cancel, and aggregate pause/resume/cancel icons have visible tooltips and accessible names identifying their scope.
- Support 200% zoom without loss of primary functionality and reflow down to 320 CSS pixels.
- Use a consistent 8-pixel spacing system, responsive breakpoints, light/dark-compatible theme tokens, and clear elevation hierarchy.
- Avoid exposing raw remote/server error text. Provide a user-safe message, retry where appropriate, and the request ID for support.
