# Verificarea modulului separat de subtitrare

Verificare locală: 9 octombrie 2026. Acest raport descrie codul și mediul de test; **nu confirmă instalarea pe VPS-ul djcioko.ro**.

## Rezultate

| Verificare | Rezultat |
| --- | --- |
| Regresii JavaScript | 78 teste trecute, 0 eșuate, 0 omise |
| API, coadă, media și instalare | 63 teste Python trecute, inclusiv 5 pentru alegerea runtime-ului |
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

## Corecție pentru VPS-uri cu Python implicit mai vechi

Lansatoarele inițiale alegeau `python3` fără să caute executabilele cu număr de versiune. După raportarea erorii de preflight, s-a adăugat selecția comună a unui CPython 3.12+ și pregătirea explicită, separată, prin `setup_python.sh`. Verificarea VPS rămâne fără instalări sau descărcări.

Probe efective pe Linux x86_64 în mediul de test:

- Căutarea găsește un Python 3.12 chiar dacă executabilul implicit este incompatibil. O alegere explicită invalidă este respinsă, iar lipsa runtime-ului indică scriptul de pregătire.
- O bază Python aflată într-un director privat `0700` este respinsă înaintea instalării dependențelor. Acest defect a fost reprodus printr-un test eșuat înainte de corecție și trecut după corecție.
- Bootstrap complet din arhiva reală CPython **3.12.15**, build **20261003**: descărcare, SHA-256, extragere, mutare în calea persistentă, importuri, creare de `venv` și pornirea `pip`.
- Repetarea pregătirii a reutilizat runtime-ul fără descărcare. Fișierele sunt deținute de root, nu permit scriere altor utilizatori, iar directoarele permit traversarea de către serviciu. Legătura `/usr/bin/python3` a rămas identică.
- O descărcare coruptă controlată a fost respinsă înainte de extragere; nu s-a publicat un interpreter și fișierele temporare au fost curățate.
- Toate cele **63 de teste Python** au trecut folosind noul CPython 3.12.15 și pachetele fixate deja instalate în mediul de test. Separat, cele 32 de distribuții au fost importate și `WhisperModel` a încărcat modelul existent offline, CPU INT8, în 2,03 secunde. Nu s-au recompilat extensii și nu s-a reinstalat mediul Python al aplicațiilor existente.

Revizuirea independentă finală nu a identificat alte defecte concrete în această corecție. Arhiva aarch64 este fixată prin metadatele oficiale și SHA-256; nu a fost executată pe hardware ARM. Mediul local nu permite schimbarea UID-ului pentru proba runtime-ului, astfel că verificarea cu utilizatorul real al serviciului rămâne obligatorie în instalator, pe VPS.

## Pregătirea mutării pe OVH — 10 octombrie 2026 (Europe/Rome)

Destinația selectată este `ai.djshopitalia.it`, pe VPS-ul OVH indicat de administrator. Interfața, mesajele și destinația API au fost actualizate împreună; cache-ul aplicației este acum `ri-camera-shell-v6`.

- **78 teste JavaScript și 68 teste Python trecute** pentru această revizie. Cele 11 teste de instalare includ selectarea exactă a vhost-ului OVH între alte aplicații, respingerea unui host invalid/ambiguu, păstrarea celorlalte blocuri și oprirea înaintea modificărilor dacă o instalare existentă aparține altui domeniu.
- Verificarea HTTPS folosește mai întâi serverul local cu hostname/SNI și certificatul corect, apoi adresa publică. Un răspuns de la alt server nu poate înlocui verificarea locală.
- Rezolvarea `pip` fără instalare, cu țintă CPython 3.14 / Linux x86_64 și numai pachete binare, a găsit toate cele **32 de versiuni fixate**. Aceasta confirmă disponibilitatea wheel-urilor; încărcarea modelului pe Python-ul real al VPS-ului rămâne o verificare obligatorie a instalatorului.
- Telemetria ONNX Runtime este dezactivată înainte de import, inclusiv la validarea modelului în instalator. Mecanismul folosit este documentat în [documentația oficială ONNX Runtime](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md). Izolarea rețelei serviciului rămâne activă.
- Verificările Bash și `git diff --check` au trecut. Testul Chromium anterior rămâne dovada fluxului interfeței; nu a fost repetat pentru această schimbare de domeniu deoarece executabilul local Chromium nu mai era disponibil.

## Ce trebuie verificat la activare

### Corecția verificării răspunsurilor la activare

Prima încercare pe OVH a confirmat verificarea modelului, apoi a raportat o eroare `JSONDecodeError` și restaurarea configurațiilor anterioare. Ieșirea veche nu identifica verificarea care primise răspunsul, deci cauza exactă de pe VPS nu poate fi stabilită numai din acel mesaj.

Reproducerea locală a confirmat că răspunsurile normale ale API-ului sunt JSON: health 200, cerere fără cod 401 și lucrare absentă cu cod valid 404. Verificatorul HTTPS vechi reproduce exact eroarea raportată când primește HTML 200, HTML 301 sau un corp gol, chiar dacă următorul răspuns ar confirma readiness. [Nginx aplică configurația prin pornirea unor workeri noi la reload](https://nginx.org/en/docs/control.html); un răspuns tranzitoriu este o ipoteză plauzibilă, dar nu este dovedit drept cauza încercării OVH.

Corecția verifică statutul HTTP și forma răspunsului, adaugă diagnostice pentru fiecare etapă și așteaptă limitat disponibilitatea HTTPS. Redirecționările nu sunt urmate, verificarea certificatelor rămâne activă, iar HTML sau un JSON fără readiness nu pot produce succes. Corpul răspunsurilor și credențialele nu sunt incluse în diagnostice. Probele locale/publice și restaurarea configurațiilor la eșec rămân obligatorii.

**Verificarea corecției: 74 teste Python trecute, inclusiv 17 pentru instalare.** Cazurile noi reproduc HTML/redirecționare urmate de readiness, răspunsuri permanent greșite, eroare TLS, eroare JSON la autentificarea pe socket și păstrarea ultimului diagnostic la timeout. Un proces copil real a confirmat limita de scriere a răspunsului, fără schimbarea limitelor procesului părinte. Revizuirea independentă finală nu a identificat un blocaj rămas. Interfața nu s-a schimbat în această corecție; rezultatul anterior de 78 teste JavaScript rămâne valabil pentru aceleași fișiere.

Conexiunea SSH a mediului către OVH a fost blocată înainte de autentificare. Administratorul a executat instalatorul în propriul terminal: modelul a fost verificat, iar ultima activare a raportat restaurarea configurațiilor după eșec. Backend-ul nu este încă confirmat activ. Verificarea resurselor și lista domeniilor provin din rezultatul terminalului furnizat de administrator; corecția trebuie rulată și verificată pe acel server.

Mediul local a permis testarea HTTP prin TCP loopback, dar a refuzat crearea socketurilor AF_UNIX. Configurația de producție folosește socket UNIX; proprietatea și accesul Nginx la el sunt verificate de instalator pe serverul real. Verificarea systemd locală validează șabloanele, fără a porni un serviciu.

Administratorul trebuie să ruleze [verificarea și instalatorul](README.md#instalare-în-terminalul-vps-ului) din revizia revizuită. Succesul activării necesită rezultatul real al verificărilor pentru resurse, încărcarea modelului sub utilizatorul serviciului, `nginx -t`, socket, autentificare și ruta HTTPS publică. Este necesară și o probă pe telefonul folosit efectiv.
