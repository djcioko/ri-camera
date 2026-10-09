# FFmpeg and subtitle font dependencies

## Browser wrapper

The following files are vendored from the official `@ffmpeg/ffmpeg` **0.12.15**
package so that its Web Worker is served from the same origin as the application:

- `ffmpeg.js`: https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js
- `814.ffmpeg.js`: https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js

The wrapper is MIT licensed. The full notice is in
`LICENSE-ffmpeg-wrapper.txt`, copied from the upstream `v12.15` release:
https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/LICENSE

SHA-256 of the original upstream files, before the local patch:

| File | SHA-256 |
| --- | --- |
| ffmpeg.js | ad4cfe957589995dea03fc8de1fd5e9f5cb4558a7282913172203082a65bbfaa |
| 814.ffmpeg.js | 976f4174ae7da80c0d4f9523ee6dde3ecbce7dc2ee392b2a5322049abb9b8627 |

### Local resilience patch

Upstream 0.12.15 handles `ERROR` messages sent by a running Worker but does not
handle the Worker's native `error` or `messageerror` events. A worker script load
failure or native worker crash can therefore leave `load()` or `exec()` pending.

`ffmpeg.js` adds one private handler for both native events. It rejects all
pending requests with the worker error, clears their resolve/reject entries,
terminates and clears the Worker, and resets `loaded` to false. No FFmpeg commands,
codec settings, or data messages are changed. The regression test in
`tests/media-processor.test.js` reproduces the hanging upstream behavior and
verifies rejection and cleanup. Source map directives are removed because source
maps are not distributed here and the patched wrapper would require a new map.

When upgrading this dependency, check whether upstream now handles these events
and remove or reapply the patch accordingly.

## FFmpeg WebAssembly core

`media-processor.js` downloads the official single-thread `@ffmpeg/core`
**0.12.10** build at first use. The approximately 31 MB binary is not included in
this repository. The application stores successfully fetched core assets in the
versioned `ri-ffmpeg-core-v0.12.10` Cache Storage cache when storage is available.

- JavaScript: https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
- WebAssembly: https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
- Package metadata and license declaration: https://registry.npmjs.org/@ffmpeg/core/0.12.10
- Upstream source and build instructions: https://github.com/ffmpegwasm/ffmpeg.wasm
- Official usage example: https://ffmpegwasm.netlify.app/docs/getting-started/usage/

The package declares **GPL-2.0-or-later**. `LICENSE-ffmpeg-core-GPL.txt` contains the
GPL version 2 text. FFmpeg and its enabled libraries retain their respective
copyrights and licenses; see the upstream sources and build configuration.

The official build enables libx264, libass, FreeType, and FriBidi. The application
uses H.264 encoding and libass to render ASS subtitles with Romanian diacritics.
The single-thread core requires neither SharedArrayBuffer nor COOP/COEP headers.
Only the small wrapper and its Worker must be served from the application origin;
the fetched core JS/WASM files are loaded through Blob URLs and revoked after
each operation. Each operation terminates its Worker to release the WASM heap.

## Subtitle font

`assets/subtitles-font.ttf` is an unmodified **DejaVu Sans 2.37** regular font.
The font family name used in ASS should be `DejaVu Sans`. It contains all Romanian
letters, including the comma-below Ș/ș and Ț/ț characters.

- Font project: https://dejavu-fonts.github.io/
- License and copyright notice: `assets/subtitles-font-LICENSE.txt`
- SHA-256: `ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280`

The full original copyright/license notice accompanies the unmodified font.
