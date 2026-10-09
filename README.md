# R&I Camera — filmare cu subtitrări automate în română

Aplicație web instalabilă (PWA) pentru filmări de șantier, cu camera și microfonul telefonului sau laptopului.

## Ce include

- Cameră spate/față, reglaje de lumină și contrast, monitor de volum.
- Logo R&I, site, dată și nume șantier înregistrate direct în imagine. Poziția și dimensiunea imaginilor PNG se pot modifica.
- **Subtitrare automată în română după Stop**, activată implicit și cu preferința salvată pe dispozitiv.
- **MP4 cu textul inclus în imagine**, alb cu contur închis, centrat deasupra zonei pentru dată/șantier, cu diacritice românești.
- Fișier **SRT** separat cu textul și timpii subtitrării.
- Filmarea originală și rezultatul subtitrat păstrate separat în Arhivă (IndexedDB).
- Progres, oprirea prelucrării și reluare din Arhivă. Dacă textul a fost deja calculat, o reluare după un export nereușit refolosește acei timpi.
- **Modul separat „Subtitrări”** pentru un fișier video din telefon sau un original din Arhivă, cu procesare pe VPS-ul `ai.djshopitalia.it`.
- Procesor selectabil pentru filmările noi: **Dispozitiv** sau **Server ai.djshopitalia.it**. Alegerea inițială rămâne Dispozitiv; modulul separat folosește serverul.

## Modulul separat de subtitrare

După publicarea acestei versiuni și activarea serviciului VPS, deschide **Subtitrări** din bara de sus sau ruta `#subtitrari`. Modulul nu cere acces la cameră sau microfon.

1. Alege un video din dispozitiv sau un original din Arhivă. Alegerea fișierului nu îl transmite.
2. Apasă **Subtitrează pe server**. Aplicația salvează originalul în Arhivă înainte să îl trimită către `ai.djshopitalia.it`.
3. La final găsești **MP4 subtitrat**, **Text SRT** și **Original** în Arhivă. Pentru un video fără vorbire, rezultatul este un MP4 fără subtitrare.

Subtitrarea pe server este publică și nu cere cod sau cont.

Procesarea pe server folosește VPS-ul **OVH**, la `ai.djshopitalia.it`. Modelul vocal și limitele profilului standard sunt păstrate; interfața și Arhiva rămân în R&I Camera de pe GitHub Pages.

Pentru subtitrarea automată a filmărilor noi pe VPS, alege **Server ai.djshopitalia.it** înainte să pornești filmarea și lasă subtitrarea automată bifată. Procesorul ales la început rămâne valabil pentru întreaga filmare. Dacă subtitrarea este oprită în modul server, se păstrează originalul fără procesare.

Procesarea pe server necesită internet. Modelul vocal și motorul de export rulează pe VPS, fără descărcarea lor pe telefon în acest mod. O întrerupere de rețea păstrează originalul și referința lucrării: din Arhivă poți reconecta sau relua salvarea rezultatului. Oprirea este confirmată doar după răspunsul serverului. Fișierele de pe VPS expiră în cel mult 24 de ore, iar copia finalizată este ștearsă mai devreme după salvarea rezultatului în browser.

Limite inițiale: 512 MiB/clip, 15 minute, 3 lucrări nefinalizate și o procesare simultană. Administratorul instalează serviciul separat conform [server/README.md](server/README.md). Publicarea interfeței pe GitHub Pages nu instalează serviciul pe VPS.

## Cum o folosești

1. Deschide aplicația prin HTTPS și permite accesul la cameră și microfon.
2. Verifică bifa **Subtitrare automată · Română**.
3. Filmează, apoi apasă **Stop**. Aplicația salvează întâi originalul, apoi transcrie vocea și pregătește MP4-ul subtitrat.
4. Lasă aplicația deschisă până apare mesajul că MP4-ul este pregătit. Ecranul este menținut activ dacă browserul permite.
5. Deschide **Arhivă** și alege **MP4 subtitrat**, **Original** sau **Text SRT**.

Poți opri prelucrarea fără să pierzi originalul deja salvat. În Arhivă apare **Reia subtitrarea RO**. Clipurile mai vechi au butonul **Adaugă subtitrare RO**. Dacă oprești subtitrarea din bifă, înregistrarea rămâne disponibilă normal.

Dacă stocarea locală este plină sau indisponibilă, aplicația oferă un buton separat pentru descărcarea imediată a originalului. Descarcă fișierul înainte să închizi pagina. Arhiva browserului poate fi ștearsă de utilizator sau de sistem; descarcă filmările pe care dorești să le păstrezi.

## Voce, limbă și performanță

Funcția transcrie **vorbirea în română**. Nu este un serviciu de traducere din alte limbi. Primește pista microfonului folosit la filmare; nu identifică automat persoana care vorbește și nu separă prezentatorul de alte voci captate de același microfon. Pentru subtitrarea prezentatorului, folosește un microfon apropiat de acesta.

În modul **Dispozitiv**, înregistrările audio/video nu sunt încărcate pe un serviciu de transcriere. Recunoașterea vocală și exportul rulează local, în Web Workers. La prima folosire locală se descarcă **aproximativ 820 MB**: circa 759 MB pentru model și restul pentru motoarele și fișierele de procesare. Folosește Wi-Fi pentru prima descărcare. Modelul și motorul video sunt păstrate în cache când browserul și spațiul disponibil permit. După ștergerea cache-ului este necesară o nouă descărcare. În modul **Server ai.djshopitalia.it**, video-ul este trimis explicit către VPS-ul ales; nu este trimis unui API extern de transcriere. Modelul de pe VPS are aproximativ 1,62 GB și se descarcă o singură dată la instalare.

Procesarea pe telefon poate dura, în special pentru clipuri lungi sau rezoluții mari. Aplicația eliberează motorul video înainte de transcriere și modelul vocal înainte de export, pentru a reduce memoria folosită simultan. Păstrează pagina în prim-plan. Verifică textul rezultat, mai ales la nume proprii, termeni tehnici, zgomot puternic sau voci suprapuse; recunoașterea automată poate greși.

## Publicare sau actualizare

Interfața și modul Dispozitiv sunt statice și nu necesită un pas de build. Modul Server necesită și serviciul VPS separat din [server/README.md](server/README.md).

1. Publică **întregul conținut al folderului aplicației**, inclusiv `vendor/ffmpeg/`, fontul din `assets/` și noile fișiere JavaScript, în rădăcina proiectului `djcioko/ri-camera` sau pe un hosting HTTPS.
2. Pe GitHub Pages, configurația obișnuită este **Deploy from a branch → main → / (root)**. Publicarea necesită acces de scriere la acel repository.
3. Pentru o aplicație deja instalată, închide toate ferestrele ei și redeschide-o după actualizare, astfel încât noul service worker să se activeze. Nu este necesară ștergerea Arhivei.

Service worker-ul folosește un cache nou pentru interfață și păstrează separat cache-urile modelelor și motorului video. Aplicația funcționează și dintr-un subdirector, de exemplu cel al unui proiect GitHub Pages. Nu folosi `file://`: camera și modulele de procesare necesită un context web sigur.

## Structura implementării

| Fișier | Rol |
| --- | --- |
| `app.js` | Cameră, captură, salvare în Arhivă, progres, anulare, reîncercare și descărcări |
| `recording-pipeline.js` | Salvarea originalului înainte de procesare și stările persistente ale fiecărui clip |
| `subtitle-module.js` | Modulul separat, alegerea fișierului și trimiterea explicită pentru subtitrare |
| `server-subtitle-client.js` | Protocolul HTTPS public și verificarea răspunsurilor serverului |
| `server-subtitle-pipeline.js` | Încărcare, reconectare, salvare condiționată și anulare confirmată |
| `server/` | API FastAPI, coadă persistentă, worker nativ și instalator pentru VPS |
| `speech-recognizer.js` | Interfața cu worker-ul de recunoaștere, anulare, verificarea tăcerii și termen-limită |
| `subtitle-worker.js` | Modelul Whisper multilingv, versiunile fixate și transcrierea în română |
| `subtitle-utils.js` | Intervale valide, împărțirea textului în subtitrări și export SRT/WebVTT/ASS |
| `media-processor.js` | PCM mono la 16 kHz, font, libass și MP4 H.264/AAC prin FFmpeg WASM |
| `vendor/ffmpeg/` | Wrapper și worker FFmpeg de aceeași origine, licențe și proveniență |
| `sw.js` | Cache-ul interfeței PWA și actualizări fără ștergerea modelelor |

Se folosește motorul FFmpeg single-thread pentru a funcționa pe hosting static fără cerința `SharedArrayBuffer`/COOP/COEP. Versiunile FFmpeg și proveniența fișierelor sunt documentate în [vendor/ffmpeg/NOTICE.md](vendor/ffmpeg/NOTICE.md). Modelul vocal este `onnx-community/whisper-large-v3-turbo_timestamped` (multilingv, q4), la revizia `b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a`. Runtime-ul este Transformers.js **4.3.1**. Versiunile sunt fixate explicit în `subtitle-worker.js`; această versiune include corecțiile Whisper pentru timpii pe cuvinte descrise în [PR #1594](https://github.com/huggingface/transformers.js/pull/1594).

Modelul mai mare a fost ales după teste cu voce umană în română: variantele generice Base și Small au produs prea multe greșeli pentru subtitrare utilă. Compromisul este descărcarea mai mare și procesarea mai lentă. Nu există promisiunea unei transcrieri perfecte sau a unei viteze fixe pe telefon.

Ca reper, în browserul desktop de test, o probă audio de 7,02 secunde a necesitat aproximativ 150 de secunde pentru descărcarea inițială, inițializarea modelului și transcriere. O a doua probă de 6,24 secunde, cu modelul deja în cache, a necesitat aproximativ 104 secunde pentru inițializare și transcriere. Acestea sunt două măsurători ale testelor, fără exportul video; nu sunt un benchmark general și nu trebuie extrapolate liniar la clipuri lungi sau la un anumit telefon.

Surse ale dependențelor: [Whisper](https://github.com/openai/whisper), [Transformers.js](https://huggingface.co/docs/transformers.js), [ffmpeg.wasm](https://ffmpegwasm.netlify.app/docs/getting-started/usage/), [DejaVu Fonts](https://dejavu-fonts.github.io/).

## Verificare

Testele unitare și de regresie nu necesită servicii externe:

```bash
node --test tests/*.test.js
```

Testul opțional de integrare necesită Playwright și Chromium:

```bash
npm install --no-save playwright
npx playwright install chromium
node tests/browser-smoke.cjs
```

Poți seta `RI_CHROMIUM_EXECUTABLE` pentru un Chromium existent și `RI_QA_OUTPUT` pentru folderul de rezultate. Testul pornește un server temporar, o cameră sintetică și motorul FFmpeg real. Verifică înregistrarea, originalul salvat înainte de procesare, exportul cu subtitrare și audio, SRT, anularea și recuperarea după redeschidere. Implicit, transcriptul testului este controlat pentru a verifica determinist integrarea și randarea. Setează `RI_REAL_SPEECH_WAV` la calea unui WAV cu vorbire în română pentru a rula și modelul vocal real: testul introduce sunetul în fluxul de captură, înregistrează, transcrie și exportă automat după Stop. Acuratețea se evaluează comparând SRT-ul rezultat cu vorbirea din fișier; testul nu pretinde o transcriere perfectă.

Păstrează testarea pe telefonul folosit efectiv înainte de utilizare pentru filmări importante. Un test într-un browser desktop nu certifică memoria disponibilă, comportamentul în fundal sau viteza unui anumit telefon.
