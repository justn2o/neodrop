'use strict'

/**
 * Génération et validation des codes d'appairage, dérivation cryptographique.
 *
 * Format du code : (MOT-)+CHIFFRES, ex. « TIGRE-7342 » ou « TIGRE-LION-7342 ».
 *  - 1 à 3 mots tirés d'une liste embarquée de 520 mots français (~9 bits/mot)
 *  - 4 chiffres (0000-9999, ~13,3 bits)
 *  → ~22,3 bits (1 mot), ~31,5 bits (2 mots), ~40,7 bits (3 mots), généré
 *    exclusivement via le CSPRNG de Node. Le niveau « renforcé » sert aux
 *    transferts sensibles (voir generateCode).
 *
 * Le topic DHT et la clé d'authentification sont dérivés du code par UNE
 * passe lente de scrypt (sel fixe applicatif), puis séparés par HKDF.
 * Un attaquant qui crawle la DHT ne peut donc pas retrouver le code par
 * un simple dictionnaire SHA-256, et le code lui-même ne transite jamais
 * en clair sur le réseau (preuve par HMAC, voir swarm.js).
 *
 * Passphrase optionnelle : l'expéditeur peut exiger en plus une phrase
 * secrète libre, mélangée à la dérivation. Même si quelqu'un devine ou
 * intercepte le code, sans la passphrase il ne peut pas s'authentifier.
 */

const crypto = require('crypto')
const b4a = require('b4a')

// Sel fixe de l'application : il personnalise la dérivation pour NeoDrop.
// (Un sel par-code est impossible ici : les deux pairs ne partagent que le code.)
const APP_SALT = b4a.from('neodrop-v1-pairing-salt-2026', 'utf8')

// Paramètres scrypt volontairement coûteux (~100 ms) pour ralentir le
// brute-force hors-ligne des topics observés sur la DHT.
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

// Liste embarquée de 520 mots français courts, sans accents, faciles à
// dicter au téléphone. Vérifiée unique et complète par les tests.
const WORDS = [
  'TIGRE', 'LION', 'CHAT', 'CHIEN', 'LOUP', 'OURS', 'RENARD', 'LAPIN',
  'CHEVAL', 'VACHE', 'MOUTON', 'CHEVRE', 'COCHON', 'POULE', 'COQ', 'CANARD',
  'OIE', 'CYGNE', 'AIGLE', 'FAUCON', 'HIBOU', 'CORBEAU', 'PIE', 'MERLE',
  'PIGEON', 'MOINEAU', 'COLIBRI', 'FLAMANT', 'PELICAN', 'MOUETTE', 'PINGOUIN', 'PHOQUE',
  'MORSE', 'BALEINE', 'DAUPHIN', 'REQUIN', 'THON', 'SAUMON', 'TRUITE', 'CARPE',
  'BROCHET', 'ANGUILLE', 'CRABE', 'HOMARD', 'CREVETTE', 'HUITRE', 'ESCARGOT', 'LIMACE',
  'FOURMI', 'ABEILLE', 'GUEPE', 'FRELON', 'PAPILLON', 'CIGALE', 'GRILLON', 'CRIQUET',
  'SCARABEE', 'SCORPION', 'SERPENT', 'VIPERE', 'COBRA', 'PYTHON', 'LEZARD', 'IGUANE',
  'GECKO', 'TORTUE', 'CRAPAUD', 'CASTOR', 'LOUTRE', 'BLAIREAU', 'FURET', 'HERISSON',
  'TAUPE', 'SOURIS', 'RAT', 'HAMSTER', 'ECUREUIL', 'MARMOTTE', 'SINGE', 'GORILLE',
  'BABOUIN', 'PANDA', 'KOALA', 'KANGOUROU', 'ZEBRE', 'GIRAFE', 'ELEPHANT', 'BUFFLE',
  'BISON', 'ANTILOPE', 'GAZELLE', 'CHAMEAU', 'LAMA', 'ALPAGA', 'JAGUAR', 'LEOPARD',
  'GUEPARD', 'PUMA', 'LYNX', 'PANTHERE', 'HYENE', 'CHACAL', 'COYOTE', 'AUTRUCHE',
  'PAON', 'DINDON', 'FAISAN', 'PERDRIX', 'CAILLE', 'TOUCAN', 'POMME', 'POIRE',
  'PECHE', 'ABRICOT', 'PRUNE', 'CERISE', 'FRAISE', 'MURE', 'MYRTILLE', 'CASSIS',
  'RAISIN', 'MELON', 'PASTEQUE', 'ANANAS', 'BANANE', 'ORANGE', 'CITRON', 'KIWI',
  'MANGUE', 'PAPAYE', 'GOYAVE', 'LITCHI', 'COCO', 'DATTE', 'FIGUE', 'OLIVE',
  'AVOCAT', 'TOMATE', 'CAROTTE', 'NAVET', 'RADIS', 'POIREAU', 'OIGNON', 'AIL',
  'CELERI', 'FENOUIL', 'ASPERGE', 'BROCOLI', 'CHOU', 'EPINARD', 'SALADE', 'LAITUE',
  'ENDIVE', 'POIVRON', 'PIMENT', 'CONCOMBRE', 'CITROUILLE', 'POTIRON', 'HARICOT', 'LENTILLE',
  'POIS', 'MAIS', 'BLE', 'ORGE', 'AVOINE', 'SEIGLE', 'RIZ', 'NOIX',
  'NOISETTE', 'AMANDE', 'PISTACHE', 'CHATAIGNE', 'MARRON', 'SOLEIL', 'LUNE', 'ETOILE',
  'COMETE', 'PLANETE', 'GALAXIE', 'NUAGE', 'PLUIE', 'NEIGE', 'GRELE', 'ORAGE',
  'TONNERRE', 'ECLAIR', 'VENT', 'BRISE', 'TEMPETE', 'OURAGAN', 'TORNADE', 'ROSEE',
  'GIVRE', 'GLACE', 'OCEAN', 'MER', 'LAC', 'RIVIERE', 'FLEUVE', 'RUISSEAU',
  'CASCADE', 'SOURCE', 'ETANG', 'MARAIS', 'PLAGE', 'DUNE', 'DESERT', 'OASIS',
  'MONTAGNE', 'COLLINE', 'VALLEE', 'PLAINE', 'PLATEAU', 'FALAISE', 'GROTTE', 'CANYON',
  'VOLCAN', 'GLACIER', 'ICEBERG', 'FORET', 'JUNGLE', 'SAVANE', 'PRAIRIE', 'BOSQUET',
  'ARBRE', 'CHENE', 'HETRE', 'ERABLE', 'BOULEAU', 'SAPIN', 'PIN', 'CEDRE',
  'CYPRES', 'OLIVIER', 'PALMIER', 'BAMBOU', 'SAULE', 'TILLEUL', 'PLATANE', 'PEUPLIER',
  'ORME', 'FRENE', 'NOYER', 'FLEUR', 'ROSE', 'TULIPE', 'JASMIN', 'LILAS',
  'MUGUET', 'IRIS', 'ORCHIDEE', 'PIVOINE', 'DAHLIA', 'LAVANDE', 'MIMOSA', 'TOURNESOL',
  'VIOLETTE', 'BLEUET', 'CACTUS', 'FOUGERE', 'MOUSSE', 'LIERRE', 'ROSEAU', 'TREFLE',
  'TABLE', 'CHAISE', 'FAUTEUIL', 'CANAPE', 'LIT', 'ARMOIRE', 'COMMODE', 'BUREAU',
  'ETAGERE', 'MIROIR', 'LAMPE', 'BOUGIE', 'LANTERNE', 'TAPIS', 'RIDEAU', 'COUSSIN',
  'OREILLER', 'ASSIETTE', 'BOL', 'TASSE', 'VERRE', 'CARAFE', 'BOUTEILLE', 'COUTEAU',
  'CASSEROLE', 'MARMITE', 'FOUR', 'FRIGO', 'BALAI', 'SEAU', 'EPONGE', 'SAVON',
  'SERVIETTE', 'BROSSE', 'PEIGNE', 'RASOIR', 'CISEAUX', 'AIGUILLE', 'FIL', 'BOUTON',
  'TISSU', 'LAINE', 'COTON', 'SOIE', 'CUIR', 'VELOURS', 'MARTEAU', 'CLOU',
  'VIS', 'TOURNEVIS', 'PINCE', 'SCIE', 'HACHE', 'PELLE', 'RATEAU', 'BROUETTE',
  'ECHELLE', 'CORDE', 'CHAINE', 'CADENAS', 'CLE', 'SERRURE', 'PORTE', 'FENETRE',
  'BALCON', 'ESCALIER', 'TOIT', 'MUR', 'BRIQUE', 'TUILE', 'CHEMINEE', 'JARDIN',
  'POTAGER', 'CLOTURE', 'PORTAIL', 'FONTAINE', 'PUITS', 'MOULIN', 'GRANGE', 'ETABLE',
  'CABANE', 'CHALET', 'CHATEAU', 'TOUR', 'PONT', 'ROUTE', 'CHEMIN', 'SENTIER',
  'VILLAGE', 'VILLE', 'QUARTIER', 'AVENUE', 'RUELLE', 'PLACE', 'MARCHE', 'BOUTIQUE',
  'USINE', 'ATELIER', 'GARAGE', 'HANGAR', 'PHARE', 'PORT', 'QUAI', 'NAVIRE',
  'BATEAU', 'VOILIER', 'BARQUE', 'CANOE', 'RADEAU', 'ANCRE', 'VOILE', 'RAME',
  'BOUSSOLE', 'CARTE', 'GLOBE', 'VALISE', 'SAC', 'PANIER', 'COFFRE', 'BOITE',
  'CARTON', 'PAQUET', 'CADEAU', 'RUBAN', 'FICELLE', 'PAPIER', 'CAHIER', 'LIVRE',
  'ROMAN', 'JOURNAL', 'LETTRE', 'TIMBRE', 'CRAYON', 'STYLO', 'GOMME', 'REGLE',
  'COMPAS', 'PINCEAU', 'PEINTURE', 'TABLEAU', 'STATUE', 'PHOTO', 'CAMERA', 'MONTRE',
  'HORLOGE', 'REVEIL', 'LUNETTES', 'CHAPEAU', 'CASQUETTE', 'BONNET', 'ECHARPE', 'GANT',
  'MANTEAU', 'VESTE', 'CHEMISE', 'PANTALON', 'JUPE', 'ROBE', 'PYJAMA', 'BOTTE',
  'SANDALE', 'CEINTURE', 'CRAVATE', 'POCHE', 'MOUCHOIR', 'PARAPLUIE', 'EVENTAIL', 'BIJOU',
  'BAGUE', 'COLLIER', 'BRACELET', 'COURONNE', 'TRESOR', 'PIECE', 'BILLET', 'TIRELIRE',
  'PIANO', 'GUITARE', 'VIOLON', 'FLUTE', 'TROMPETTE', 'TAMBOUR', 'HARPE', 'BANJO',
  'ORGUE', 'CHANSON', 'MELODIE', 'RYTHME', 'CONCERT', 'OPERA', 'THEATRE', 'CINEMA',
  'CIRQUE', 'CLOWN', 'JONGLEUR', 'ACROBATE', 'MAGICIEN', 'BALLON', 'TOUPIE', 'DOMINO',
  'PUZZLE', 'RAQUETTE', 'FILET', 'STADE', 'PISTE', 'PODIUM', 'MEDAILLE', 'TROPHEE',
  'DRAPEAU', 'FUSEE', 'AVION', 'HELICE', 'PLANEUR', 'PARACHUTE', 'TRAIN', 'WAGON',
  'TRAMWAY', 'METRO', 'VELO', 'TANDEM', 'MOTO', 'SCOOTER', 'VOITURE', 'CAMION',
  'TRACTEUR', 'REMORQUE', 'CARAVANE', 'SIRENE', 'FEU', 'FLAMME', 'BRAISE', 'CENDRE',
  'FUMEE', 'CHARBON', 'CRISTAL', 'DIAMANT', 'RUBIS', 'SAPHIR', 'PERLE', 'AMBRE',
  'CUIVRE', 'BRONZE', 'ARGENT', 'PLATINE', 'ACIER', 'PLOMB', 'ZINC', 'NICKEL',
  'MARBRE', 'GRANIT', 'ARDOISE', 'SABLE', 'ARGILE', 'CRAIE', 'SILEX', 'GALET'
]

// 1 à 3 mots, puis 4 chiffres. Le groupe 1 capture toute la partie « mots ».
const CODE_REGEX = /^([A-Z]{2,12}(?:-[A-Z]{2,12}){0,2})-(\d{4})$/

/**
 * Génère un nouveau code d'appairage, ex. « TIGRE-7342 ».
 * Tirage uniforme via crypto.randomBytes (jamais Math.random).
 *
 * opts.words : nombre de mots (1 par défaut ; 2-3 pour un code renforcé).
 * On peut aussi passer opts.strength ∈ {'normal','high','max'}.
 */
function generateCode (opts = {}) {
  const byStrength = { normal: 1, high: 2, max: 3 }
  let words = opts.words || byStrength[opts.strength] || 1
  words = Math.min(3, Math.max(1, words | 0))
  // crypto.randomInt s'appuie sur le CSPRNG (randomBytes) et évite tout
  // biais modulo, quelle que soit la taille de la liste.
  const parts = []
  for (let i = 0; i < words; i++) parts.push(WORDS[crypto.randomInt(0, WORDS.length)])
  parts.push(crypto.randomInt(0, 10000).toString().padStart(4, '0'))
  return parts.join('-')
}

/**
 * Normalise la saisie utilisateur (espaces, minuscules, tiret oublié)
 * et retourne le code canonique, ou null si le format est invalide.
 */
function normalizeCode (input) {
  if (typeof input !== 'string') return null
  let s = input.trim().toUpperCase().replace(/\s+/g, '-').replace(/-+/g, '-')
  // Tolère « TIGRE7342 » sans séparateur (un seul mot collé aux chiffres).
  const noSep = s.match(/^([A-Z]{2,12})(\d{4})$/)
  if (noSep) s = `${noSep[1]}-${noSep[2]}`
  return CODE_REGEX.test(s) ? s : null
}

/**
 * Une passe lente de scrypt sur le secret → secret maître de 32 octets.
 * Asynchrone pour ne jamais bloquer le process main.
 */
function deriveMaster (secret) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(b4a.from(secret, 'utf8'), APP_SALT, 32, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

/**
 * Dérive du code (et d'une passphrase optionnelle) les deux secrets :
 *  - topic   : clé de rendez-vous DHT (32 octets) — c'est la seule valeur
 *              visible publiquement (annoncée sur la DHT Hyperswarm) ;
 *  - authKey : clé HMAC du challenge-réponse — jamais transmise.
 * HKDF garantit que connaître le topic ne donne pas la clé d'auth.
 *
 * Si une passphrase est fournie, elle est mêlée à l'entrée de scrypt : le
 * topic ET la clé d'auth en dépendent, donc le pair doit connaître les deux.
 * Sans passphrase, le résultat est identique à la version d'origine.
 */
async function deriveSecrets (code, passphrase = '') {
  const secret = passphrase ? `${code}\n${passphrase}` : code
  const master = await deriveMaster(secret)
  const topic = b4a.from(crypto.hkdfSync('sha256', master, APP_SALT, b4a.from('neodrop/topic'), 32))
  const authKey = b4a.from(crypto.hkdfSync('sha256', master, APP_SALT, b4a.from('neodrop/auth'), 32))
  return { topic, authKey }
}

module.exports = { WORDS, generateCode, normalizeCode, deriveSecrets, CODE_REGEX }
