# RepWake — landing page

Static Next.js site. Deploys to Vercel with no configuration and no server
cost: `output: 'export'`, no API routes, nothing to render at request time.

## Deploy

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # static export to out/
```

Then either connect the repo at vercel.com/new, or:

```bash
npx vercel --prod
```

Set one environment variable in the Vercel dashboard:

```
NEXT_PUBLIC_APK_URL = https://github.com/<you>/repwake/releases/latest/download/repwake.apk
```

## Where to put the APK

**Use GitHub Releases, not `public/`.** A React Native APK is 40–70 MB, and
files in `public/` count toward Vercel's deployment size limit — you would be
paying build time and bandwidth to serve a binary that GitHub hosts for free.
Point `NEXT_PUBLIC_APK_URL` at a release asset.

If you do drop an APK in `public/` anyway, `vercel.json` already sets the right
`Content-Type` (`application/vnd.android.package-archive`) and a
`Content-Disposition` header. Without those, browsers render the APK as text
instead of downloading it.

## The demo is the real engine

`components/RepDemo.tsx` imports `lib/repMachine.ts`, which is the same
rep-counting state machine that ships inside the APK — not a reimplementation.
It is pure TypeScript with no React Native imports, so it runs unchanged in a
browser.

A browser has no proximity sensor, so a press pad stands in for your chest, and
the accelerometer stream is synthesised. That is what makes the demo worth
having: the toggle switches between "phone on the floor" and "phone in your
hand", and the same presses get counted or thrown out. Verified before
shipping:

| Simulated input | Result |
|---|---|
| 8 correct presses, phone on floor | 8 reps counted |
| Same presses, phone in hand | 0 reps — all `device_moved` |
| 120 ms holds | 0 reps — all `flick` |
| Presses 500 ms apart | 4 of 8 — rest `too_fast` |

After changing detection logic in the app, run:

```bash
npm run sync:engine
```

Otherwise the site demos stale rules, which is worse than having no demo.

## Note on Next version

Pinned to 15.5.25. Do not drop to 15.1.x — it carries CVE-2025-66478.
