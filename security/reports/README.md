# CRSF reports

`npm run security:verify` writes its reports to `security/reports/out/` (git-ignored):

- `crsf-report.json` — deterministic machine-readable report for one commit (no timestamps, no secrets).
- `crsf-report.md` — short human summary of the same run.

Reports are reproducible from the commit plus the recorded environment capabilities, so they are not committed. Use `--out <dir>` to write elsewhere, e.g. to attach a report to a release review.
