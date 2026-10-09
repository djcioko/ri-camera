# Modul separat de subtitrare pe VPS

## Scop și decizii

Utilizatorul a cerut un modul separat de subtitrare, a ales explicit procesare pe server și a selectat VPS-ul `djcioko.ro`. Interfața rămâne în R&I Camera. Rezultatul urmărit este încărcarea unui clip existent sau folosirea unui original din Arhivă, transcriere în română și descărcarea unui MP4 subtitrat și a unui SRT, fără descărcarea modelului vocal pe telefon în modul server.

Implementarea se pregătește în ramura `feat/server-subtitle-module`, pornită din `efe99ccc233fdcbbab41466fbfbae31e2be923eb`. Publicarea se propune prin PR pentru Cioko. Nu există o conexiune SSH configurată în sesiunea de implementare: instalatorul trebuie să verifice VPS-ul real și să fie executat în terminalul lui înainte de a declara serviciul activ.

## Interfață și original

- Buton separat **Subtitrări**, cu rută `#subtitrari`, încărcare video din dispozitiv și selectare din Arhivă. Accesarea directă a rutei nu pornește camera/microfonul.
- Alegerea unui fișier nu îl transmite. **Subtitrează pe server** salvează întâi originalul și apoi începe încărcarea.
- Destinația este afișată: `djcioko.ro`. Un cod privat introdus în interfață autentifică cererile. Codul rămâne doar în memoria paginii; nu intră în Git, URL-uri, IndexedDB sau loguri.
- Originalul și numele său real sunt păstrate; un MOV nu este redenumit WebM. Lipsa previzualizării în browser nu împiedică analiza pe server.
- Camera poate selecta explicit procesorul **Dispozitiv** sau **Server djcioko.ro**, cu descrierea destinației. Preferința implicită existentă rămâne locală până când utilizatorul selectează serverul; modulul separat folosește întotdeauna serverul. Se îngheață alegerea la pornirea filmării.
- Modul server nu invocă Whisper/FFmpeg în browser și nu revine automat la procesarea locală dacă serverul e indisponibil. Cu subtitrarea automată dezactivată, salvează originalul fără conversie locală implicită.
- Progres, anulare confirmată, reconectare după întreruperea rețelei și reluarea descărcării rezultatului. Persistarea rezultatului precedă ștergerea copiei de pe server.

## Contract HTTP v1

URL public de bază: `https://djcioko.ro/api/ri-subtitles/v1`.
Backend-ul expune `/v1`; Nginx elimină prefixul `/api/ri-subtitles`.
Autentificare: `Authorization: Bearer <cod>`, verificată înainte de citirea corpului. CORS exact `https://djcioko.github.io`, fără cookies și fără redirecționarea cererilor private.

| Metodă / rută | Contract |
| --- | --- |
| `GET /health` | Disponibilitate și limite, fără date despre clipuri; fără autentificare |
| `POST /jobs` | JSON `{requestId, filename, bytes, language:"ro"}`; idempotent după `requestId`; răspunde cu snapshot |
| `PUT /jobs/{id}/source` | Corp binar original, streaming; verifică limita și numărul declarat de octeți; snapshot după acceptarea completă |
| `GET /jobs/{id}` | Snapshot al lucrării, cu timpi reali și text doar când rezultatul este disponibil |
| `GET /jobs/{id}/output` | MP4 autentificat, numai după validarea rezultatului |
| `GET /jobs/{id}/subtitles` | SRT autentificat, numai pentru rezultat final |
| `DELETE /jobs/{id}` | Anulare și ștergere idempotentă; confirmă oprirea procesului înainte de starea finală |

Snapshot: `{id, requestId, status, progress, message, createdAt, expiresAt, inputBytes, outputBytes, duration, width, height, cues, error}`. `progress` este finit, între 0 și 1, pentru faza curentă. `cues` conține `{start,end,text}`, în secunde. `error` este `null` sau `{code,message}` fără căi interne. ID-ul serverului este UUID hex de 32 de caractere; `requestId` este identificator aleator al clientului de 16–80 caractere ASCII `[A-Za-z0-9_-]`.

Stări: `awaiting_upload`, `uploading`, `queued`, `transcribing`, `rendering`, `ready`, `empty`, `failed`, `cancelled`, `expired`. Un rezultat fără vorbire este `empty`, cu MP4 disponibil fără subtitrare. Erorile HTTP au forma `{"error":{"code":"...","message":"..."}}`.

## Persistență și concurență

Clientul păstrează `subtitleProcessor`, `originalName` și `remoteJob:{requestId,id,status,expiresAt}` în clip. Salvează `requestId` înainte de POST și ID-ul serverului înainte de PUT. Reconectarea verifică lucrarea existentă și nu reîncarcă un original acceptat.

Actualizările serverului folosesc o tranzacție IndexedDB care verifică existența clipului și identitatea `remoteJob.requestId`; un răspuns vechi nu poate recrea un clip șters sau suprascrie o reluare nouă. Un răspuns HTML, MP4 gol, lungime greșită sau timpi invalizi nu poate produce starea locală `ready`. O eroare de salvare păstrează lucrarea și rezultatul serverului pentru reluare.

Abortarea fetch nu reprezintă anulare pe server. Clientul folosește o cerere DELETE separată, cu termen scurt; dacă nu primește confirmare, păstrează identitatea lucrării și afișează că oprirea nu a fost confirmată. Închiderea paginii lasă o lucrare acceptată să continue.

## Serviciul pe server

FastAPI, Uvicorn cu un singur proces, SQLite pentru identitatea și starea lucrărilor, un supervisor cu maximum un proces media activ. Textul recunoscut și fișierele se păstrează în directorul privat al lucrării, nu în loguri. Generarea începe doar după primirea completă a fișierului.

Limite implicite configurabile: original maximum 512 MiB; durată maximum 900 s; maximum 3 lucrări nefinalizate; spațiu total pentru lucrări 4 GiB; minimum 2 GiB liberi; rezultat și fișiere maximum 24 h; rezervări fără upload maximum 15 minute; termen pe lucrare 3600 s. Nu se publică rezultate trunchiate pentru a respecta limita. Datele expirate, WAV, fișierele parțiale, textul și rezultatele sunt șterse. Repornirea recuperează lucrările acceptate și elimină uploadurile parțiale.

Procesul media rulează în propriul process group; anularea încheie procesul și descendenții cu TERM urmat de KILL dacă e necesar. Erorile și închiderea serviciului nu lasă FFmpeg activ în fundal.

### Interfața worker-ului

`python -m ri_subtitles.worker --job-dir PATH --model-dir PATH --font-path PATH --cpu-threads 2 --max-duration 900 --max-pixels 16777216`

Intrare fixă: `source.media`. Worker-ul scrie atomic `progress.json` (`status`, `progress`, `message`) și `result.json`. La succes acesta conține `status` (`ready`/`empty`), `duration`, `width`, `height`, `cues`, `outputBytes`; fișierele finale sunt `output.mp4` și `subtitles.srt`. La eroare scrie `status:"failed"` și `error:{code,message}`, apoi iese nenul. Numele interne sunt fixe; nici numele originalului, nici parametrii HTTP nu sunt interpretați de shell.

### Recunoaștere și export

Python 3.12+, `faster-whisper==1.2.1`, `ctranslate2==4.8.2`, CPU INT8, maximum 2 fire și o lucrare. Model `dropbox-dash/faster-whisper-large-v3-turbo`, revizie `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`. `model.bin`: 1617884929 octeți, SHA-256 `e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da`. Descărcare o singură dată la instalare; toate cele cinci fișiere sunt verificate înainte de readiness. Worker-ul este offline, cu model local, limbă `ro`, `word_timestamps=True`, VAD și `condition_on_previous_text=False`.

FFprobe verifică formatul, durata, fluxurile, dimensiunile și rotația; se acceptă containere MOV/MP4 și Matroska/WebM, inclusiv HEVC decodabil pe server. Playlisturile și sursele de rețea sunt refuzate. FFmpeg normalizează aceeași axă temporală pentru audio și imagine, produce PCM mono 16 kHz și MP4 H.264/AAC yuv420p, maximum 1920 pe latura lungă, dimensiuni pare, font DejaVu cu diacritice. Pista originală de sunet se păstrează. Rezultatul este verificat înainte de expunere. Acuratețea și viteza pe VPS nu sunt promise fără măsurători reale.

## Instalare și verificare

Serviciu dedicat `ri-subtitles`, socket UNIX `/run/ri-subtitles/api.sock`, fără port TCP nou. Nginx proxiază numai prefixul nou. Instalatorul rezolvă fișierul/vhost-ul TLS activ pentru `djcioko.ro`, face backup cu dată, introduce un include idempotent, validează `nginx -t` și reîncarcă numai serviciul necesar. Lipsa sau ambiguitatea vhost-ului oprește instalarea. Nu se înlocuiește configurația Nginx integral.

Codul serviciului, mediul virtual, modelul și stocarea lucrărilor sunt separate. Cheia este generată pe VPS și ținută în fișier root-only; nu se imprimă în raport. systemd aplică utilizator dedicat, directoare private, limite CPU/memorie și restricții de rețea după instalarea modelului. Instalatorul verifică Python, FFmpeg, RAM, disc și proprietatea socketului înainte de activare.

Verificări: teste API reale în proces (auth înainte de corp, limite, idempotency, upload/restart/delete/expiry), pipeline JS și regresiile camerei, export FFmpeg real cu sunet/diacritice/rotație, test ASR uman dacă modelul este disponibil. Activarea VPS și verificarea rutei publice necesită rezultatele terminalului real.
