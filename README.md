# R&I Camera — aplicație filmare șantier

Aplicație web (PWA) pentru videograful R&I Grupul de Firme.

## Ce face acum (situația 1)

- Cameră spate / față, buton pe ecran
- 3 reglaje: lumină, contrast, saturație + zoom
- Indicator volum (VU) pe ecran
- Logo R&I și numărul **0727.300.302** sunt puse automat pe fiecare cadru filmat
- Înregistrările rămân în aplicație (IndexedDB pe telefon)
- Acasă: Salvează pe telefon / laptop din bibliotecă
- Bot editor (versiune 1): descarcă un fișier montaj din toate clipurile

## Cum o folosești

1. Pune folderul pe GitHub Pages (sau orice hosting HTTPS).
2. Deschide site-ul pe telefon.
3. Acceptă camera + microfon.
4. Opțional: „Adaugă pe ecranul principal” ca să meargă ca aplicație.

**Important:** browserul cere HTTPS pentru cameră (GitHub Pages e OK).

## GitHub Pages (rapid)

```bash
cd ri-camera
git init
git add .
git commit -m "R&I Camera v1"
git branch -M main
git remote add origin https://github.com/CONTUL_TAU/ri-camera.git
git push -u origin main
```

Apoi: Settings → Pages → Deploy from branch `main` / root.

## Următorul pas (situația 2)

Bot editor real: tăiere silenzioasă, clipuri scurte, muzică, titluri, export MP4 cu ffmpeg.
