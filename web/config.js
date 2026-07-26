// Runtime configuration for the web UI.
//
// At deploy time the CDK stack overwrites this file in S3 with the real API
// base URL (from the API_BASE_URL env var, or the stack's own API endpoint),
// so the UI needs no manual configuration. This committed default leaves it
// empty, which lets local development fall back to a value saved in Settings.
window.APP_CONFIG = { apiBaseUrl: "" };
