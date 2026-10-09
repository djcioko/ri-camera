# Subtitrări românești pe VPS-ul djcioko.ro

Serviciu separat pentru modulul **Subtitrări** și pentru filmările cu procesorul **Server djcioko.ro** din R&I Camera. Transcrie vocea în română și produce MP4 H.264/AAC cu text inclus în imagine și SRT. Procesarea are loc pe VPS; serviciul nu trimite înregistrarea către un API extern de recunoaștere.

Interfața rămâne pe GitHub Pages. Publicarea acestui cod în repository **nu activează automat VPS-ul**. Instalatorul trebuie executat în terminalul serverului de către administrator. Nu introduceți parola SSH, cheia privată sau codul aplicației în GitHub ori în conversații.

## Utilizare

După instalare și publicarea interfeței, deschideți `https://djcioko.github.io/ri-camera/#subtitrari`, alegeți video-ul sau originalul din Arhivă, introduceți codul privat și apăsați **Subtitrează pe server**. Alegerea fișierului nu îl încarcă. Originalul se salvează local înainte de upload și rămâne disponibil separat de rezultat.

Codul rămâne în memoria paginii; redeschiderea cere reintroducerea lui. Destinația vizibilă este `djcioko.ro`. Modulul nu pornește camera/microfonul. În camera principală, procesarea pe server este o alegere explicită înainte de filmare; Dispozitiv rămâne alegerea inițială.

## Limite și resurse

| Proprietate | Valoare implicită |
| --- | --- |
| Original | maximum 512 MiB |
| Durata originalului | maximum 900 secunde |
| Lucrări nefinalizate | maximum 3, cu o singură procesare activă |
| Spațiu pentru fișierele lucrărilor | maximum 4 GiB, cu rezervă de 2 GiB pe disc |
| Expirarea rezervării fără upload complet | 15 minute |
| Păstrarea media și rezultatului | maximum 24 de ore de la acceptarea uploadului |
| Termen total de procesare | 3600 secunde |
| Export | H.264/AAC, yuv420p, maximum 1920 pe latura lungă |
| CPU worker | maximum 2 fire; unitatea systemd are plafon 150% CPU |
| Memorie serviciu | MemoryHigh 3 GiB, MemoryMax 4 GiB |

Pragul conservator al instalatorului este **2 CPU, 6 GiB RAM total, 3 GiB RAM disponibili, 10 GiB liberi pe volumul `/var/lib` și 2 GiB pe `/opt`**. Acesta este un prag de pornire, nu o garanție de viteză pe un VPS partajat. Instalatorul se oprește dacă resursele sau dependențele lipsesc. Nu schimbă automat distribuția, Python-ul sistemului sau serviciile altor aplicații.

Sunt necesare Linux cu systemd 245+, glibc 2.28+, Python 3.12+ cu `venv`, FFmpeg 6+ cu libass/libx264/AAC, Nginx, Git și curl. Pachetele Python se instalează într-un mediu virtual dedicat. Modelul fixat are aproximativ **1,62 GB**, descărcat o singură dată la instalare; pe durata procesării modelul este folosit offline.

## Instalare în terminalul VPS-ului

Folosiți un checkout al **reviziei exacte revizuite în PR**. Comanda de livrare a PR-ului indică SHA-ul complet; verificați-l cu `git rev-parse HEAD`. Nu rulați o comandă de instalare primită pentru alt repository sau o ramură modificată între timp.

Din rădăcina checkout-ului:

```bash
sudo bash server/scripts/inspect_vps.sh
sudo bash server/deploy/install.sh
```

Dacă Python 3.12 este instalat sub un nume separat, indicați executabilul existent:

```bash
sudo env RI_PYTHON_BIN=/usr/bin/python3.12 bash server/scripts/inspect_vps.sh
sudo env RI_PYTHON_BIN=/usr/bin/python3.12 bash server/deploy/install.sh
```

Prima comandă doar verifică resursele, dependențele și vhost-ul TLS activ. Nu modifică configurații și nu imprimă conținutul Nginx. A doua copiază codul din commit, instalează dependențele fixate, descarcă și verifică modelul și îl încarcă o dată offline înainte de activare.

Instalatorul identifică exact un bloc TLS cu `server_name djcioko.ro` în rezultatul real `nginx -T`. Un vhost absent, ambiguu, indirect sau un prefix deja folosit în altă configurație oprește instalarea pentru verificare manuală. Se introduce un singur include în blocul selectat; restul textului rămâne neschimbat.

Fișierele existente care urmează să fie modificate se salvează cu dată într-un director privat `/var/backups/ri-subtitles/`. Instalatorul rulează `nginx -t`, verifică unitățile systemd, pornește numai serviciul propriu și verifică autentificarea și readiness pe socket. Reîncarcă Nginx și verifică ruta HTTPS. Dacă activarea eșuează, restaurează configurațiile salvate și starea anterioară a serviciului. Modelul și release-ul descărcat rămân pentru diagnostic; nu se șterg filmări locale sau datele altor aplicații.

La succes, scriptul imprimă revizia, directorul de backup și confirmarea verificării prin socket și HTTPS. Păstrați acest rezultat ca dovadă a activării. O verificare locală a codului sau un PR creat nu înlocuiește acest rezultat.

### Codul privat

Codul este generat aleator pe VPS și păstrat în `/etc/ri-subtitles/service.env`, cu acces doar root. Pentru a-l vedea **doar în terminalul propriu**, administratorul poate rula:

```bash
sudo sed -n 's/^RI_SUBTITLES_ACCESS_CODE=//p' /etc/ri-subtitles/service.env
```

Introduceți codul în interfața R&I Camera. Nu îl adăugați în surse, URL, rapoarte sau capturi de ecran. Codul comun dă acces la lucrările acestui serviciu; nu există conturi separate sau izolare între mai mulți utilizatori care cunosc același cod. Administratorul îl distribuie doar persoanelor care trebuie să folosească modulul.

## Fișiere și operare

| Cale | Rol |
| --- | --- |
| `/opt/ri-subtitles/releases/<sha>` | Cod și mediu virtual pentru o revizie |
| `/opt/ri-subtitles/current` | Referință la release-ul activ |
| `/var/lib/ri-subtitles-model/<revizie>` | Model verificat, fără scriere din serviciu |
| `/var/lib/ri-subtitles` | SQLite și directoare private ale lucrărilor |
| `/etc/ri-subtitles/service.env` | Cod și configurare, root-only |
| `/run/ri-subtitles/api.sock` | Socket creat de systemd, acces pentru worker-ul Nginx |
| `/etc/nginx/snippets/ri-subtitles.conf` | Exclusiv ruta `/api/ri-subtitles/` |

Serviciul are utilizator propriu, fără autentificare interactivă; nu deschide un port TCP. Socketul este creat de systemd și transmis către Uvicorn. `PrivateNetwork` și restricția AF_UNIX împiedică accesul de rețea al worker-ului. Nginx expune HTTPS și transmite cererile autentificate.

Comenzi de stare:

```bash
sudo systemctl status ri-subtitles.service ri-subtitles.socket --no-pager
curl --fail https://djcioko.ro/api/ri-subtitles/v1/health
```

O actualizare folosește instalatorul din următoarea revizie revizuită. El păstrează codul privat și limitele opționale din configurare. Modificările manuale ale fișierelor gestionate necesită revizuire înainte de actualizare; scriptul nu le suprascrie automat. Nu ștergeți automat release-uri sau backupuri: verificați mai întâi ce revizie folosește unitatea activă.

## API și confidențialitate

Prefix public `https://djcioko.ro/api/ri-subtitles/v1`; backend `/v1`. Toate cererile private folosesc `Authorization: Bearer <cod>`. Codul este verificat înainte de citirea uploadului. CORS permite exact `https://djcioko.github.io`, fără cookies. Ruta publică `/health` comunică doar readiness și limitele.

| Rută | Funcție |
| --- | --- |
| `POST /jobs` | Rezervare idempotentă `{requestId,filename,bytes,language:"ro"}` |
| `PUT /jobs/{id}/source` | Original binar, streaming și limite verificate |
| `GET /jobs/{id}` | Starea și, la final, timpii/textul recunoscut |
| `GET /jobs/{id}/output` | MP4 final verificat |
| `GET /jobs/{id}/subtitles` | SRT final |
| `DELETE /jobs/{id}` | Oprire confirmată a procesului și ștergere |

Înregistrările și transcriptul nu apar în loguri. SQLite păstrează identitatea, numele original și starea; textul recunoscut se află numai în fișierele private ale lucrării. Rezultatul este șters după salvarea confirmată în browser sau la expirare. Închiderea paginii lasă o lucrare acceptată să continue. Anularea trimite o cerere separată, iar interfața nu declară oprirea dacă răspunsul nu ajunge.

Sunt acceptate MOV/MP4 și Matroska/WebM cu fluxuri decodabile de FFmpeg-ul instalat, inclusiv HEVC când este disponibil. Nu se acceptă URL-uri, playlisturi sau căi de fișiere furnizate de client. Fără vorbire, exportul rămâne MP4 fără subtitrare. Transcrierea este în română; nu traduce alte limbi, nu separă automat prezentatorul de ceilalți vorbitori și poate greși la zgomot, nume sau termeni tehnici.

## Verificarea codului

Dintr-un mediu de dezvoltare, separat de cel al aplicațiilor existente:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.lock.txt -r server/requirements-test.txt
PYTHONPATH=server .venv/bin/python -m unittest discover -s server/tests -v
node --test tests/*.test.js
bash -n server/scripts/inspect_vps.sh server/deploy/install.sh
```

Testele includ cereri FastAPI/ASGI reale în proces, upload întrerupt, limite, idempotency, anulare cu proces copil, recuperare, expirare, patch-uri Nginx pe configurații de probă și export FFmpeg nativ cu sunet/rotație/diacritice. Testele nu instalează modelul și nu contactează VPS-ul.

Testul opțional `node tests/server-browser-smoke.cjs` folosește Chromium/Playwright, IndexedDB real și un transport HTTP controlat; necesită `RI_QA_MP4` cu un MP4 valid. `RI_CHROMIUM_EXECUTABLE` poate indica un Chromium existent. El verifică originalul salvat înainte de POST, zero acces la cameră pe ruta modulului, lipsa motoarelor locale și salvarea rezultatului înainte de DELETE. Nu dovedește disponibilitatea VPS-ului.

Pentru proba vocală reală, `server/scripts/download_model.py --model-dir <director>` instalează modelul fixat, iar `python -m ri_subtitles.worker --help` descrie procesarea locală a unui `source.media`. Acuratețea și viteza pe un VPS anume necesită proba efectivă pe acel server.

### Dependențe și surse

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper), versiunea 1.2.1; [CTranslate2](https://opennmt.net/CTranslate2/), 4.8.2, CPU INT8.
- [Modelul fixat](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo/tree/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf), revizia `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`; model.bin SHA-256 `e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da`.
- [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/settings/), [FFmpeg](https://ffmpeg.org/ffmpeg.html), [proxy_pass Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass), [socketuri systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html).
- Fontul DejaVu din `assets/subtitles-font.ttf`, cu licența inclusă în repository.
