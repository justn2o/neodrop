# NeoDrop

Application desktop de transfert de fichiers **pair-à-pair** entre ordinateurs
distants, **sans aucun serveur à héberger**. Les pairs se découvrent via la DHT
publique [Hyperswarm](https://github.com/holepunchto/hyperswarm) et établissent
une connexion directe chiffrée de bout en bout (protocole Noise, UDP hole
punching).

## Fonctionnement

1. **Envoyer** : glisse un ou plusieurs fichiers — **ou un dossier entier** —
   dans l'application (ou via les boutons « Fichiers… » / « Dossier… »). Un
   code d'appairage court est généré (ex. `TIGRE-7342`).
2. **Recevoir** : sur l'autre PC, n'importe où dans le monde, saisis le code.
3. Le destinataire **confirme explicitement** le transfert et **choisit le
   dossier de destination** (bouton « Modifier… », mémorisé) — rien ne s'écrit
   sur son disque avant son accord. L'arborescence d'un dossier est recréée à
   l'identique.
4. Transfert avec progression des deux côtés (vitesse, temps restant), puis
   **vérification d'intégrité SHA-256**.
5. Le code est à **usage unique** et expire après **15 minutes** sans connexion.

## Sécurité

- Code généré via le CSPRNG de Node (`crypto.randomBytes`), ~22 bits d'entropie.
- Topic DHT dérivé du code par **scrypt** (coûteux) puis HKDF : pas de
  brute-force trivial des topics observés sur la DHT.
- Le code **ne transite jamais en clair** : challenge-réponse mutuel par
  HMAC-SHA256 sur des nonces aléatoires, avec protection anti-réflexion.
- Côté expéditeur, **3 échecs d'authentification invalident le code**.
- Sockets chiffrées de bout en bout nativement par Hyperswarm (Noise).
- Renderer Electron sandboxé : `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. Toute la logique réseau/fichiers
  vit dans le process main.
- Noms de fichiers reçus assainis (pas de `../`, caractères interdits Windows,
  noms réservés) ; collisions gérées (`fichier (1).ext`). Pour un dossier,
  chaque composante du chemin relatif est assainie : impossible d'écrire hors
  du dossier de destination.

## Prérequis

- [Node.js](https://nodejs.org) ≥ 20 et npm
- Accès Internet (UDP) pour la DHT Hyperswarm

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

Couvre : génération/validation des codes, dérivation des secrets, framing,
assainissement des noms de fichiers, challenge-réponse (bon et mauvais code,
invalidation après 3 échecs), transfert multi-fichiers de bout en bout avec
vérification du hash, rejet d'un fichier corrompu, annulation et nettoyage des
`.part`, plafond mémoire en streaming.

## Build Windows

```bash
npm run build:win
```

Produit un installateur NSIS (`.exe`) dans `dist/`. L'installateur laisse le
choix du dossier d'installation. Les cibles macOS/Linux sont prêtes en
commentaire dans `electron-builder.yml`.

> **Cross-build depuis Linux/macOS** : la cible NSIS nécessite alors wine
> (avec le support 32 bits, paquet `wine32`). Sous **Windows**, aucun
> prérequis supplémentaire — lance simplement `npm run build:win`.

## Structure du projet

```
├── package.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.js      # cycle de vie Electron, fenêtre
│   │   ├── code.js       # génération/validation du code, dérivation du topic
│   │   ├── swarm.js      # Hyperswarm : join, connexions, challenge-réponse
│   │   ├── transfer.js   # protocole d'envoi/réception, chunks, hash
│   │   └── ipc.js        # handlers IPC
│   ├── preload/
│   │   └── index.js      # API minimale exposée au renderer
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── test/                 # tests automatisés (npm test)
```

## Limites connues

- Les **deux applications doivent être ouvertes simultanément** pendant tout
  le transfert (pas de boîte aux lettres : c'est du direct).
- Certains réseaux très restrictifs (double NAT/CGNAT, pare-feu d'entreprise)
  peuvent **empêcher le hole punching** ; le transfert échoue alors avec un
  message de timeout.
- Au **premier lancement sous Windows**, autoriser l'application dans le
  pare-feu Windows quand la boîte de dialogue apparaît (nécessaire pour les
  connexions entrantes).
- Les fichiers sont envoyés séquentiellement ; pas de reprise après coupure
  (un transfert interrompu doit être relancé avec un nouveau code).
