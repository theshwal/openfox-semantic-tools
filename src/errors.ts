export class ProviderError extends Error {
  /**
   * Numeric HTTP status for a non-2xx answer, when the runtime actually
   * responded.
   *
   * It is deliberately a bare number: it carries no body, headers, URL or
   * credentials. Upstream error bodies can echo submitted source or secrets, so
   * they are never stored or logged — only the status, which is what actually
   * distinguishes a targeted protocol rejection (400) from a transport or
   * infrastructure condition (401/403, 429, 5xx).
   *
   * It stays optional: a network failure, timeout or abort has no status.
   */
  readonly httpStatus?: number

  constructor(readonly code: string, message: string, httpStatus?: number) {
    super(message)
    this.name = 'ProviderError'
    this.httpStatus = httpStatus
  }
}
