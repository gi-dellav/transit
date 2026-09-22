<p align="center">
  <img src="logo.svg" width="96" height="96" alt="Transit logo" />
</p>

<h1 align="center">Transit</h1>

<p align="center">Know exactly when to leave home to catch your transit on time.</p>

<p align="center">
  <a href="https://gi-dellav.github.io/transit/">Live demo</a> ·
  <a href="https://github.com/gi-dellav/transit">GitHub</a>
</p>

## What it does

- Countdown to **leave by** (`transit time − walk time`) and to the next **transit**
- Multiple locations, each with multiple stations (`walk time + first departure + frequency`)
- Flags missed departures and shows the next catchable one
- Optional "remind me" browser notification when it's time to leave
- Installable PWA — works offline, data stays in `localStorage`

## Develop

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install
bun run dev       # dev server
bun run check     # type check
bun run build     # static build into dist/
bun run preview   # preview the build
```

Built with Svelte 5 + Vite + TailwindCSS 4. Deploys to GitHub Pages from `dist/` on every push to `main`.
