// Where Grafana is, for the owner-only /grafana/ pass-through in server.mjs.
//
// From PR #3. It also created a Grafana account for every person
// who registered, copying the password they had just typed into PromptForge.
// Removed 22 Sep 2026: one copy of a password is the safe number, and nobody
// needs a Grafana account now - the dashboard is the owner's, reached through
// PromptForge's own login, and Grafana serves it view-only to that
// pass-through. Grafana's admin login (compose.yaml, .env) is still there for
// editing dashboards.
//
// GRAFANA_URL unset means monitoring is not set up here, which is the normal
// state everywhere but a compose install started with `--profile monitoring`.
// It used to default to http://grafana:3000, so every box without Grafana
// tried to reach one on every request to /grafana/.

export function getGrafanaUrl() {
  return process.env.GRAFANA_URL || null;
}
