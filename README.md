# Convertor

Outil web pour **convertir n'importe quel fichier**, **zipper**, et **transférer de gros fichiers chiffrés de bout en bout**.
Destiné à `https://convertor.jbleroy.fr`.

## Fonctionnalités

### Conversion
- **Images** : PNG, JPG, WebP, GIF, BMP, TIFF, ICO, HEIC, AVIF, PSD, SVG → PNG, JPG, WebP, GIF, BMP, TIFF, ICO, PDF
- **Vidéo** : MP4, WebM, MKV, MOV, AVI, WMV, FLV… → MP4, WebM, MKV, MOV, AVI, GIF animé, ou extraction audio
- **Audio** : MP3, WAV, OGG, FLAC, AAC, M4A, Opus, WMA, AIFF… → MP3, WAV, OGG, FLAC, AAC, M4A, Opus
- **Documents** : DOC/DOCX/ODT/RTF/TXT ↔ PDF, DOCX, ODT, RTF, TXT, HTML, Markdown, EPUB
- **Tableurs / présentations** : XLS/XLSX/ODS/CSV, PPT/PPTX/ODP → PDF et formats Office/OpenDocument
- **PDF** → PNG/JPG (une image par page), TXT, DOCX, ODT
- **Markdown / HTML / EPUB / RST / LaTeX** ↔ entre eux, et vers PDF/DOCX
- **Données** : JSON ↔ YAML ↔ CSV ↔ TSV (et vers XLSX/ODS)
- Plusieurs fichiers d'un coup, résultat en **ZIP**, ou **« ZIP sans conversion »**
- Les fichiers sont supprimés du serveur dès la réponse envoyée

### Transfert sécurisé
- **Chiffrement de bout en bout dans le navigateur** (AES-256-GCM, blocs de 8 Mio) : le serveur ne voit jamais le contenu, ni le nom des fichiers
- **La clé est dans le fragment du lien** (`/t/<id>#<clé>`), jamais envoyé au serveur ; `Referrer-Policy: no-referrer`
- **Mot de passe optionnel** : PBKDF2-SHA256 600 000 itérations, combiné à la clé du lien (il faut les deux)
- **Accès verrouillé** : un jeton dérivé de la clé (HKDF) est exigé pour récupérer les blocs chiffrés ; le serveur n'en stocke que l'empreinte SHA-256. **10 échecs = transfert détruit**
- **Intégrité** : nonce = index du bloc + drapeau « dernier bloc » (construction STREAM) → toute altération, troncature ou réordonnancement est détecté
- **Expiration** (1 h → 30 j) et **nombre de téléchargements limité** (autodestruction possible dès le 1er)
- **Gros fichiers** : jusqu'à 50 Go (réglable), envoi en parallèle avec reprise automatique, téléchargement déchiffré **en flux** via un service worker (aucune limite mémoire)
- Plusieurs fichiers ou un dossier → ZIP créé à la volée dans le navigateur (limite 4 Go pour un ZIP ; un fichier seul n'a pas cette limite)
- « Mes envois » : suivi des téléchargements et suppression à tout moment (stocké dans le navigateur, sans la clé)
- CSP stricte, aucun script tiers, aucun cookie, aucun traceur, pas de journal d'accès

## Déploiement (Docker + HTTPS automatique)

Prérequis : un serveur avec Docker, et un enregistrement DNS `convertor.jbleroy.fr` (A/AAAA) pointant dessus. Ports 80 et 443 ouverts.

```bash
git clone https://github.com/jbleroy75/convertor.git && cd convertor
cp .env.example .env          # ajuster les quotas si besoin
docker compose up -d --build
```

Caddy obtient le certificat Let's Encrypt tout seul. L'application tourne :
- sur un **réseau Docker interne sans accès Internet** (un fichier piégé ne peut faire aucune requête sortante),
- en utilisateur non-root, système de fichiers en lecture seule, sans capacités Linux,
- avec une politique ImageMagick durcie (`deploy/imagemagick-policy.xml`), FFmpeg limité aux démuxeurs locaux, Pandoc en `--sandbox`.

Les transferts sont stockés dans le volume `transfers` et nettoyés automatiquement (expiration, quota, envois abandonnés après 24 h).

### Déploiement en production (Coolify)

Le site tourne sur Coolify, qui construit le `Dockerfile` et gère Traefik et le HTTPS.
Réglages de l'application : dépôt public `https://github.com/jbleroy75/convertor` (branche `main`),
Build Pack **Dockerfile**, domaine `https://convertor.jbleroy.fr`, port `3000`,
variable `TRUST_PROXY=1`, volume persistant monté sur `/data`.

**Déploiement automatique** : à chaque push sur `main`, la GitHub Action lance les tests, puis demande
à Coolify de redéployer, suit le build (et affiche ses logs en cas d'échec), puis vérifie
`https://convertor.jbleroy.fr/healthz`. Configuration unique, dans GitHub → *Settings → Secrets and variables → Actions* :

| Secret | Valeur |
|---|---|
| `COOLIFY_WEBHOOK` | Coolify → l'application → *Webhooks* → **Deploy Webhook** (URL `…/api/v1/deploy?uuid=…`) |
| `COOLIFY_TOKEN` | Coolify → *Keys & Tokens → API Tokens* : jeton avec les droits **deploy** et **read** |

Tant que ces secrets sont absents, l'étape de déploiement est ignorée.

Le `docker-compose.yml` (avec Caddy) reste disponible pour héberger le site sur un serveur sans Coolify.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `DOMAIN` | `convertor.jbleroy.fr` | Domaine public |
| `TRANSFER_MAX_GB` | `50` | Taille max d'un transfert |
| `TRANSFER_STORAGE_GB` | `200` | Quota disque total des transferts |
| `CONVERT_MAX_FILE_MB` | `1024` | Taille max d'un fichier à convertir |
| `CONVERT_CONCURRENCY` | nb CPU − 1 (max 4) | Conversions lourdes simultanées |
| `APP_MEM_LIMIT` | `4g` | Mémoire max du conteneur |

## Développement

Outils requis en local : Node 20+, `ffmpeg`, `imagemagick`, `libreoffice`, `poppler-utils`, `librsvg2-bin`, et le binaire officiel de [pandoc](https://github.com/jgm/pandoc/releases) (celui de Debian/Ubuntu casse `--sandbox` pour docx/odt/epub ; indiquer son chemin via `PANDOC_BIN`).

```bash
npm install
npm start          # http://localhost:3000
npm test           # crypto, conversions réelles, API de transfert
```

## Architecture

```
server/
  index.js              application Express, en-têtes de sécurité
  convert/index.js      règles de conversion et moteurs (ffmpeg, ImageMagick, LibreOffice, pandoc, poppler, JS)
  routes/convert.js     POST /api/convert, GET /api/formats
  routes/transfers.js   API de transfert (le serveur ne manipule que des blocs chiffrés)
  transfers/store.js    stockage disque + nettoyage
public/
  js/crypto.js          chiffrement E2E (WebCrypto), partagé page / service worker / tests
  js/send.js            découpage, chiffrement, envoi parallèle
  js/receive.js, sw.js  déchiffrement en flux côté destinataire
```
