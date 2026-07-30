export function shouldRejectWeChatClientCertificateRequest(
  ownsRequestingWebContents: boolean,
): boolean {
  // Ownership is the security boundary. A certificate challenge can occur
  // before a redirect is rejected, so URL classification must not weaken it.
  return ownsRequestingWebContents;
}
