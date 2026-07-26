export const PRODUCTION_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:*; worker-src 'self' blob:";

export const DEVELOPMENT_CONTENT_SECURITY_POLICY = PRODUCTION_CONTENT_SECURITY_POLICY.replace(
  "connect-src 'self' http://127.0.0.1:*",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* ws://localhost:*",
);
