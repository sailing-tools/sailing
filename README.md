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

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, builds and publishes `dist/web/` to
GitHub Pages at https://sailing.georgejacques.com.

DNS (GoDaddy > Domains > georgejacques.com > DNS): a `CNAME` record with name `sailing` pointing to
`veracia-admin.github.io`.

## Data

- Coastline: ONS local authority boundaries via martinjc/UK-GeoJSON, Open Government Licence. Not for navigation.
- Polar: estimated Jeanneau Sun Odyssey 410. Import an ORC polar in the app for real numbers.
