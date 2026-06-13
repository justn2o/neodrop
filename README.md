# NeoDrop

Application desktop de transfert de fichiers **pair-à-pair** entre ordinateurs
distants, **sans aucun serveur à héberger**. Les pairs se découvrent via la DHT
publique [Hyperswarm](https://github.com/holepunchto/hyperswarm) (et, sur un même
réseau, via mDNS) et établissent une connexion directe chiffrée de bout en bout
(protocole Noise, UDP hole punching).

En bref : fichiers **et dossiers**, **compression** à la volée des fichiers
compressibles, **reprise après coupure**, **découverte sur le réseau local**,
**QR code** d'appairage, codes **renforcés** et **passphrase** optionnels,
**notifications** système, **icône de la barre des tâches**, **historique**,
aperçu par **miniatures**, **limite de débit**, et un **mode ligne de commande**.

## Fonctionnement

1. **Envoyer** : glisse un ou plusieurs fichiers — **ou un dossier entier** —
   dans l'application (ou via les boutons « Fichiers… » / « Dossier… »). Un
   code d'appairage court est généré (ex. `TIGRE-7342`) et affiché aussi en
   **QR code** (à scanner depuis un téléphone).
2. **Recevoir** : sur l'autre PC, n'importe où dans le monde, saisis le code.
   S'il se trouve dans le presse-papier, il est pré-rempli automatiquement.
3. Le destinataire **confirme explicitement** le transfert et **choisit le
   dossier de destination** (bouton « Modifier… », mémorisé) — rien ne s'écrit
   sur son disque avant son accord. L'arborescence d'un dossier est recréée à
   l'identique, et un **aperçu** s'affiche pour les images.
4. Transfert avec progression des deux côtés (vitesse, temps restant), puis
   **vérification d'intégrité SHA-256**. Une coupure réseau peut être **reprise**
   sans tout renvoyer.
5. Le code est à **usage unique** et expire après **15 minutes** sans connexion.

## Options d'envoi

Dépliable « Options » sur l'écran d'envoi :

- **Robustesse du code** : 1 mot (~22 bits), 2 mots (~31 bits) ou 3 mots
  (~41 bits) pour les transferts sensibles.
- **Passphrase** : phrase secrète exigée en plus du code. Elle est mêlée à la
  dérivation cryptographique (topic ET clé d'auth) : sans elle, impossible de
  s'appairer même en connaissant le code.
- **Limite de débit** (Mo/s) pour ne pas saturer la connexion.
- **Compression** des fichiers compressibles (texte, code, etc.), transparente.

## Reprise après coupure

Si la connexion tombe en plein transfert, le fichier partiel reçu est conservé
dans un cache local. En relançant la réception avec le **même code**, NeoDrop
**reprend là où il s'était arrêté** plutôt que de tout renvoyer. Le SHA-256 final
porte toujours sur le fichier complet : un préfixe douteux est détecté et le
fichier est, le cas échéant, redemandé.

## Découverte sur le réseau local

Quand les deux pairs sont sur le même réseau, NeoDrop les trouve en quelques
millisecondes via **mDNS**, en parallèle de la DHT. La socket locale est
enveloppée dans le **même chiffrement Noise** que Hyperswarm : la confidentialité
de bout en bout est préservée (l'UI affiche « réseau local »). Échec silencieux :
si le multicast est bloqué, la DHT prend le relais.

## Compression à la volée

Les formats compressibles (`.txt`, `.json`, `.csv`, `.svg`, code source…) au-delà
de 4 Ko sont compressés en **brotli** pendant le transport, puis décompressés à
l'arrivée. Les formats déjà compressés (zip, jpg, mp4…) sont envoyés tels quels.
La compression est purement liée au transport : le **SHA-256 porte sur les
données d'origine**, l'intégrité n'est pas affaiblie.

## Historique, notifications, barre des tâches

- **Historique** des derniers transferts (accessible depuis l'accueil), stocké
  localement, effaçable.
- **Notifications** système à la connexion d'un pair et en fin de transfert,
  utiles quand la fenêtre est en arrière-plan.
- **Icône de la barre des tâches** (tray) : garder un code en attente en
  arrière-plan et revenir à la fenêtre d'un clic.

## Ligne de commande

NeoDrop fonctionne aussi sans interface (mêmes garanties : chiffré, vérifié) :

```bash
# Envoyer (affiche un code) — fichiers et/ou dossiers
node bin/cli.js send fichier.zip dossier/ --strength high --pass "ma phrase"

# Recevoir
node bin/cli.js receive TIGRE-7342 --out ./reçus --yes
```

Options : `--strength high|max`, `--pass PHRASE`, `--no-compress`,
`--limit Mo/s`, `--out DOSSIER`, `--yes` (accepter sans confirmation).
Installé globalement, la commande s'appelle simplement `neodrop`.

## Sécurité

- Code généré via le CSPRNG de Node (`crypto.randomBytes`), ~22 bits d'entropie
  (1 mot), jusqu'à ~41 bits en mode renforcé (3 mots).
- Topic DHT dérivé du code par **scrypt** (coûteux) puis HKDF : pas de
  brute-force trivial des topics observés sur la DHT.
- **Passphrase optionnelle** mêlée à la dérivation : protège même si le code
  est deviné ou intercepté.
- Le code **ne transite jamais en clair** : challenge-réponse mutuel par
  HMAC-SHA256 sur des nonces aléatoires, avec protection anti-réflexion.
- Côté expéditeur, **3 échecs d'authentification invalident le code**.
- Sockets chiffrées de bout en bout nativement par Hyperswarm (Noise) — y
  compris sur le **réseau local** (même protocole Noise).
- Renderer Electron sandboxé : `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. Toute la logique réseau/fichiers
  vit dans le process main.
- Noms de fichiers reçus assainis (pas de `../`, caractères interdits Windows,
  noms réservés) ; collisions gérées (`fichier (1).ext`). Pour un dossier,
  chaque composante du chemin relatif est assainie : impossible d'écrire hors
  du dossier de destination.

## Prérequis

- [Node.js](https://nodejs.org) ≥ 20 et npm
- Accès Internet (UDP) pour la DHT Hyperswarm (la découverte locale via mDNS
  fonctionne aussi hors Internet, entre pairs du même réseau)

## Lancement en développement

```bash
npm install
npm start
```

Pour tester un transfert complet en local, lance **deux instances** :

```bash
npm start   # terminal 1 → Envoyer
npm start   # terminal 2 → Recevoir
```

## Tests automatisés

```bash
npm test
```

Couvre (29 tests) : génération/validation des codes (dont codes renforcés et
passphrase), dérivation des secrets, framing, assainissement des noms de
fichiers, challenge-réponse (bon et mauvais code, invalidation après 3 échecs),
transfert multi-fichiers et de dossiers de bout en bout avec vérification du
hash, **compression**, **envoi pipeliné** de nombreux fichiers, **reprise après
coupure**, rejet d'un fichier corrompu, annulation et nettoyage des `.part`,
plafond mémoire en streaming, et un aller-retour complet via une DHT locale.

## Build (Windows, macOS, Linux)

```bash
npm run build:win     # installateur NSIS (.exe)
npm run build:mac     # .dmg (x64 + arm64)
npm run build:linux   # AppImage (x64)
```

Les artefacts sont produits dans `dist/`. L'installateur Windows laisse le choix
du dossier d'installation. L'icône commune est `build/icon.png`.

> **Cross-build depuis Linux/macOS** : la cible NSIS nécessite alors wine
> (avec le support 32 bits, paquet `wine32`). Sous **Windows**, aucun
> prérequis supplémentaire — lance simplement `npm run build:win`.

## Structure du projet

```
├── package.json
├── electron-builder.yml
├── bin/
│   └── cli.js           # mode ligne de commande (sans Electron)
├── build/
│   └── icon.png         # icône de l'application / de l'installateur
├── src/
│   ├── main/
│   │   ├── index.js      # cycle de vie Electron, fenêtre, tray
│   │   ├── code.js       # codes (1-3 mots), passphrase, dérivation du topic
│   │   ├── swarm.js      # Hyperswarm + mDNS : join, connexions, auth
│   │   ├── lan.js        # découverte réseau local (mDNS) chiffrée Noise
│   │   ├── transfer.js   # protocole : chunks, hash, compression, reprise
│   │   └── ipc.js        # handlers IPC, notifications, historique, QR, miniatures
│   ├── preload/
│   │   └── index.js      # API minimale exposée au renderer
│   ├── assets/           # icônes embarquées (app + tray)
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── test/                 # tests automatisés (npm test)
```

## Limites connues

- Les **deux applications doivent être ouvertes simultanément** pendant tout
  le transfert (pas de boîte aux lettres : c'est du direct). La **reprise après
  coupure** ne fonctionne que si l'on relance avec le même code, les deux pairs
  étant à nouveau en ligne.
- Certains réseaux très restrictifs (double NAT/CGNAT, pare-feu d'entreprise)
  peuvent **empêcher le hole punching** ; le transfert passe alors par un relais
  (chiffré) ou échoue avec un message de timeout.
- Au **premier lancement sous Windows**, autoriser l'application dans le
  pare-feu Windows quand la boîte de dialogue apparaît (nécessaire pour les
  connexions entrantes et la découverte locale).
