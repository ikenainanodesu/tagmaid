# Security

## Reporting

Use this repository's **Security → Report a vulnerability** form for suspected vulnerabilities. Do not post credentials, private URLs, browser profiles, or exploit details in public Issues or Discussions. Include the version, affected feature, prerequisites, and minimal reproduction with synthetic data.

The latest published release is the maintenance target. No response-time guarantee is provided.

## Data boundaries

AI generation sends tab titles, sanitized URLs, IDs, optional existing-group context, and your instructions directly to the API you configure. Queries, fragments, and embedded credentials are removed; titles and paths are not anonymized. Review the outgoing data and your provider's policies. Local domain sorting makes no API request.

Keys remain in session storage unless you opt into local persistence. Persistent extension storage is not an encrypted vault. Processes with sufficient browser-profile access are outside the extension's isolation boundary. Undo records contain original tab metadata in session storage.

Production code requires HTTPS except for loopback HTTP, refuses redirects, uses a 90-second deadline, validates model plans, and requires preview confirmation. It has no content scripts or remote executable code. Responses have no explicit byte-size limit; use a service you trust to handle data and return reasonable responses.

## Public source and releases

Machine-specific agent configuration, local indexes, diagnostics, test profiles, environment files, and common private-key files are excluded from Git. Release packages contain the runtime extension and public documentation. Do not add real credentials to examples or fixtures. Existing test credentials are synthetic values used with mock requests.

A source review does not guarantee the absence of vulnerabilities. Automated checks use mocked APIs; actual provider behavior, native permission-dialog interaction, browser implementation security, and operating-system protections require separate validation.
