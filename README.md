# Solent Race Calculator

Set wind (over the ground) and tide, draw a start line, place marks, and see tide-adjusted laylines,
course to steer, CoG/SOG and the vector triangle (CTW + tide = CoG) for each leg. Chart or grid background,
works on phone and desktop.

## Develop

```bash
npm ci
npm test          # navigation maths unit tests
npm run typecheck
npm run build:web # dist/web/index.html, a single self-contained page
```

`npm run build:local` makes `dist/local.html` with React inlined for offline testing.

## Deploy to georgejacques.com/sailing (GoDaddy)

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, builds and uploads `dist/web/` to
`public_html/sailing/` over FTPS. Add three repository secrets under Settings > Secrets and variables > Actions:

| Secret | Value |
| --- | --- |
| `FTP_SERVER` | Your GoDaddy FTP host, e.g. `ftp.georgejacques.com` |
| `FTP_USERNAME` | An FTP account from cPanel > FTP Accounts |
| `FTP_PASSWORD` | That account's password |

If your FTP account is already rooted at `public_html`, change `server-dir` to `./sailing/`.

Manual alternative: upload `dist/web/index.html` to `public_html/sailing/` in cPanel File Manager.

## Data

- Coastline: ONS local authority boundaries via martinjc/UK-GeoJSON, Open Government Licence. Not for navigation.
- Polar: estimated Jeanneau Sun Odyssey 410. Import an ORC polar in the app for real numbers.
