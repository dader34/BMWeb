# BMWeb beta report collector

One Cloudflare Worker + one KV namespace (the account has R2 disabled; KV
needs no dashboard opt-in and a beta's volume sits well inside its free tier:
1k writes/day, 1 GB, 25 MB/value -- a report is ~50-200 KB).

## Deployed 2026-08-26

    worker    https://bmweb-beta.danner-baumgartner.workers.dev
    endpoint  https://bmweb-beta.danner-baumgartner.workers.dev/report
              (baked into BETA_ENDPOINT_DEFAULT in core/journal.js;
               Settings key 'betaEndpoint' overrides per-install)
    KV        BETA -> namespace 57678a6ee1904245a2c89ce7c0109aee
    TOKEN     tools/beta/.token.local (gitignored) -- guards READS only

Re-deploy after edits:

    cd tools/beta && npx wrangler deploy

## Read the reports

    TOKEN=$(cat tools/beta/.token.local)
    curl -s -H "Authorization: Bearer $TOKEN" \
      'https://bmweb-beta.danner-baumgartner.workers.dev/reports' | jq .
    curl -s -H "Authorization: Bearer $TOKEN" \
      'https://bmweb-beta.danner-baumgartner.workers.dev/report?key=r/2026-08-27/...json' | jq .

## What a report holds

app+browser version, current screen route, the session journal (screens
opened, every job run with JOB_STATUS and timing, captured crashes), the last
~60 wire telegrams (plus the 400-row verbose capture when the tester had
`busTrace.start()` on), cable status, theme/demo/INPA-mode flags, and a stable
anonymous tester id. VINs in text fields are masked to their first 10 chars.
