/**
 * Header merge and validation.
 *
 * The whole point of this plugin lives here: HTTP field names are
 * case-insensitive on the wire, so `User-Agent`, `user-agent` and `USER-AGENT`
 * are one header. A naive `{ ...base, ...override }` merge keeps two entries
 * whose case differs and leaves the surviving spelling to the HTTP stack; some
 * stacks then join both values with ", " on the wire. Every merge in this
 * plugin therefore keys by the lowercase name and emits exactly one field per
 * name.
 *
 * @module dsh-plugin-custom-headers/headers
 */

/** A header bag as YAML and JSON can express it: one string value per name. */
export type HeaderRecord = Record<string, string>

/** Header names Fetch refuses to carry, so configuration cannot even be loaded with them. */
const FETCH_RESERVED = new Set(['content-length', 'transfer-encoding', 'expect', 'upgrade'])

/**
 * Reject a configured header Fetch cannot put on a request.
 * @param label - the provider route, for the diagnostic.
 * @param headers - configured headers, when any.
 * @throws Error naming the offending field.
 */
export function assertValidHeaders (label: string, headers: HeaderRecord | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') {
      throw new Error(`dsh-plugin-custom-headers: provider "${label}" header "${name}" must be a string`)
    }
    if (FETCH_RESERVED.has(name.toLowerCase())) {
      throw new Error(`dsh-plugin-custom-headers: provider "${label}" header "${name}" is owned by the HTTP layer and cannot be set here`)
    }
    try {
      // The Fetch implementation is the authority on representable fields and
      // on single-line values, so ask it rather than re-implementing RFC 9110.
      void new Headers([[name, value]])
    } catch {
      throw new Error(`dsh-plugin-custom-headers: provider "${label}" header "${name}" is not valid for Fetch; use a valid HTTP field name and a single-line value representable as bytes`)
    }
  }
}

/**
 * Merge header sources case-insensitively, last source winning.
 *
 * Every source is flattened into one entry per lowercase name. The emitted
 * field keeps the spelling of the source that supplied the winning value, so a
 * configured `User-Agent` reaches the wire spelled exactly as configured while
 * the attribution header it replaced disappears completely.
 *
 * @param sources - header bags in increasing precedence.
 * @returns a record with unique, case-insensitively distinct field names.
 */
export function mergeHeadersCaseInsensitive (...sources: readonly (HeaderRecord | undefined)[]): HeaderRecord {
  const merged = new Map<string, [string, string]>()
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value !== 'string') continue
      merged.set(name.toLowerCase(), [name, value])
    }
  }
  return Object.fromEntries(merged.values())
}

/**
 * Names of a header bag, for diagnostics that must not print secret values.
 * @param headers - header bag.
 * @returns the configured field names.
 */
export function headerNames (headers: HeaderRecord | undefined): string[] {
  return Object.keys(headers ?? {})
}
