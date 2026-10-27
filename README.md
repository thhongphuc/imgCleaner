# imgCleaner (Web App)

A **100% Client-Side (WebAssembly)** web application that strips EXIF and metadata from images, videos, and PDF documents directly inside your browser.

Zero server uploads. All files are processed locally in browser memory using **ExifTool 13.42** compiled to WebAssembly (`@uswriting/exiftool` + `@6over3/zeroperl-ts`).

---

## Key Features

- **100% Local Browser Processing**: Files never leave your device—no backend server, no cloud storage, and complete privacy.
- **Full ExifTool 13.42 Engine in WebAssembly**: Inspects before/after metadata diffs and strips EXIF, GPS, XMP, IPTC, MakerNotes, and document properties.
- **Batch & Folder Support**: Drag-and-drop multiple files or entire folders, then download individual cleaned files or all cleaned files at once as a `.zip` archive (powered by `fflate`).
- **Configurable Cleaning Rules**:
  - Preserve image orientation (`Orientation` tag)
  - Preserve color profile (`ICC_Profile` tag)
  - Preserve timestamps (`FileModifyDate` / `CreateDate`)
  - Optional `_clean` filename suffix
- **Dark / Light / System Theme & 24 Languages**: Automatic locale detection and persistent settings via `localStorage`.

---

## Supported Formats

- **Images**: `JPG` / `JPEG`, `PNG`, `GIF`, `TIFF`, `WEBP`, `AVIF`, `HEIC` / `HEIF`, `SVG`
- **RAW Camera Formats**: `DNG`, `CR2`, `CR3`, `NEF`, `ARW`, `RW2`, `ORF`, `PEF` (`RAF` is read-only protected against unsafe writes)
- **Videos**: `MP4`, `M4V`, `MOV`, `3GP` / `3G2`
- **Documents**: `PDF`

---

## Getting Started

### Prerequisites

- **Node.js** 20+
- **Yarn** 1.x

### Install & Run Locally

```bash
# Install dependencies
yarn install

# Start Vite development server (http://localhost:5173)
yarn dev
```

### Build for Production

```bash
# Build static bundle to dist-web/
yarn build

# Preview production build locally
yarn preview
```

### Run Verification Checks

```bash
yarn typecheck
yarn lint
yarn test
```

---

## Free Static Hosting (Vercel / Cloudflare Pages / Netlify)

Because `imgCleaner` compiles into a pure static bundle (`dist-web/`), it can be hosted for free on any static hosting provider:

- **Vercel**: Configured out of the box via [`vercel.json`](./vercel.json) (`Build Command`: `yarn build`, `Output Directory`: `dist-web`).
- **Cloudflare Pages / Netlify**: Set Build command to `yarn build` and Publish directory to `dist-web`.

---

## License

[MIT](./LICENSE)
