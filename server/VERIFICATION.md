# Verificarea modulului separat de subtitrare

Verificare locală: 9 octombrie 2026. Acest raport descrie codul și mediul de test; **nu confirmă instalarea pe VPS-ul djcioko.ro**.

## Rezultate

| Verificare | Rezultat |
| --- | --- |
| Regresii JavaScript | 78 teste trecute, 0 eșuate, 0 omise |
| API, coadă, media și instalare | 58 teste Python trecute |
| Browser mobil simulat | Chromium, 390 × 844, IndexedDB real, flux complet al panoului |
| Cameră pe ruta modulului | 0 solicitări de cameră/microfon |
| Motoare locale în modul server | 0 invocări de ASR/FFmpeg în browser |
| FFmpeg nativ | MP4 H.264/AAC, yuv420p, diacritice, rotație, sunet și decodare completă |
| Dependențe | 32 pachete runtime fixate; `pip check` fără incompatibilități declarate |
| Scripturi | Bash/Python fără erori de sintaxă; `git diff --check` trecut |
| Unități systemd | `systemd-analyze verify` trecut pe șabloane cu executabilul mediului de test |

Testul interfeței folosește un transport HTTP controlat și un MP4 valid. A verificat că alegerea fișierului nu trimite nimic, originalul și `requestId` sunt deja în IndexedDB înainte de POST, numele MOV se păstrează, MP4/SRT se salvează înainte de DELETE și nu apar erori de pagină. Separat, integrarea HTTP de mai jos folosește API-ul, modelul și FFmpeg reale.

## Proba finală: MediaRecorder → HTTP → voce română → MP4/SRT

S-a creat o înregistrare **reală Chromium MediaRecorder, VP9/Opus**, cu 26 de fragmente, imagine animată de test și o probă cu voce umană în română. Fișierul WebM colectat are **208.062 octeți** și **nu declară durata în antet**, asemenea înregistrărilor WebM produse de browser.

Același fișier a fost trimis prin HTTP către un proces Uvicorn local, folosind protocolul real: rezervare, PUT binar, interogarea stării, descărcări autentificate și DELETE. Modelul fixat a fost folosit offline, fără transcript injectat și fără răspunsuri ASR simulate.

- Stări observate: `queued → transcribing → rendering → ready`.
- Durata de la încărcare până la rezultat: **14,384 secunde în acest mediu de test**.
- Rezultat: **180.069 octeți**, **640 × 360**, **7,600 secunde**, H.264 + AAC, yuv420p.
- Două intervale recunoscute: **0,14–4,66 s** și **4,66–6,76 s**, în interiorul duratei finale.
- MP4-ul a trecut atât verificarea FFprobe, cât și decodarea completă FFmpeg cu `-xerror`.
- POST repetat cu aceeași identitate a întors aceeași lucrare; CORS a acceptat exact originea GitHub Pages configurată.
- Descărcarea fără cod valid a primit HTTP 401.
- DELETE a confirmat starea finală și directorul privat al lucrării a fost eliminat.

Aceasta este o probă scurtă pe calculatorul de test, **nu un benchmark al VPS-ului și nu o estimare pentru clipuri de 15 minute**. Transcriptul conține eroarea „cheață” în loc de „gheață”; modelul nu garantează text perfect și rezultatul trebuie verificat.

O probă anterioară cu aceeași voce într-un MP4 de 7,020 secunde a trecut de asemenea prin API-ul real. Integrarea finală WebM a fost repetată după corectarea duratei lipsă și a formatului de culoare.

## Defecte găsite și corectate la revizuirea independentă

1. **Permisiunile modelului instalat ca root.** Un director temporar păstra modul 0700 după mutare. Fișierele publice verificate primesc acum 0644 și directorul 0755; instalatorul încarcă modelul ca utilizatorul serviciului înainte de activare.
2. **Durata lipsă din MediaRecorder WebM.** Un remux nativ fără recomprimare, limitat ca timp și spațiu, determină durata reală. Testele includ fișier produs efectiv de Chromium, audio întârziat, început negativ Opus și respingerea unui timeline de peste 900 secunde. Originalul rămâne identic.
3. **Reconectarea după un upload întrerupt.** Tranziția `uploading → awaiting_upload` declanșează acum un PUT cu aceleași identități, fără duplicarea lucrărilor deja acceptate.
4. **Anularea unui PUT blocat.** DELETE, expirarea și oprirea serviciului anulează și așteaptă închiderea receptorului de upload înainte de a confirma ștergerea. Reproducerea originală nu mai lasă descriptori de fișiere șterse deschiși sau spațiu necontabilizat.

Toate cele patru reproduceri au trecut după corecții. Revizuirea finală nu a identificat un blocaj rămas în implementare.

## Ce trebuie verificat la activare

Nu există o sesiune SSH configurată către VPS în mediul de implementare. Nu s-au instalat servicii, nu s-a modificat Nginx și nu s-a publicat o rută API pe djcioko.ro din această sesiune.

Mediul local a permis testarea HTTP prin TCP loopback, dar a refuzat crearea socketurilor AF_UNIX. Configurația de producție folosește socket UNIX; proprietatea și accesul Nginx la el sunt verificate de instalator pe serverul real. Verificarea systemd locală validează șabloanele, fără a porni un serviciu.

Administratorul trebuie să ruleze [verificarea și instalatorul](README.md#instalare-în-terminalul-vps-ului) din revizia revizuită. Succesul activării necesită rezultatul real al verificărilor pentru resurse, încărcarea modelului sub utilizatorul serviciului, `nginx -t`, socket, autentificare și ruta HTTPS publică. Este necesară și o probă pe telefonul folosit efectiv.
