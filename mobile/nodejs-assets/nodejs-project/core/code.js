'use strict'

const crypto = require('crypto')
const b4a = require('b4a')

const APP_SALT = b4a.from('neodrop-v1-pairing-salt-2026', 'utf8')
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const WORDS = [
  'TIGER', 'LION', 'CAT', 'DOG', 'WOLF', 'BEAR', 'FOX', 'RABBIT', 'HORSE', 'COW',
  'SHEEP', 'GOAT', 'PIG', 'HEN', 'ROOSTER', 'DUCK', 'GOOSE', 'SWAN', 'EAGLE', 'FALCON',
  'OWL', 'RAVEN', 'MAGPIE', 'BLACKBIRD', 'PIGEON', 'SPARROW', 'HUMMINGBIRD', 'FLAMINGO', 'PELICAN', 'SEAGULL',
  'PENGUIN', 'SEAL', 'WALRUS', 'WHALE', 'DOLPHIN', 'SHARK', 'TUNA', 'SALMON', 'TROUT', 'CARP',
  'PIKE', 'EEL', 'CRAB', 'LOBSTER', 'SHRIMP', 'OYSTER', 'SNAIL', 'SLUG', 'ANT', 'BEE',
  'WASP', 'HORNET', 'BUTTERFLY', 'CICADA', 'CRICKET', 'LOCUST', 'BEETLE', 'SCORPION', 'SNAKE', 'VIPER',
  'COBRA', 'PYTHON', 'LIZARD', 'IGUANA', 'GECKO', 'TURTLE', 'TOAD', 'BEAVER', 'OTTER', 'BADGER',
  'FERRET', 'HEDGEHOG', 'MOLE', 'MOUSE', 'RAT', 'HAMSTER', 'SQUIRREL', 'MARMOT', 'MONKEY', 'GORILLA',
  'BABOON', 'PANDA', 'KOALA', 'KANGAROO', 'ZEBRA', 'GIRAFFE', 'ELEPHANT', 'BUFFALO', 'BISON', 'ANTELOPE',
  'GAZELLE', 'CAMEL', 'LLAMA', 'ALPACA', 'JAGUAR', 'LEOPARD', 'CHEETAH', 'PUMA', 'LYNX', 'PANTHER',
  'HYENA', 'JACKAL', 'COYOTE', 'OSTRICH', 'PEACOCK', 'TURKEY', 'PHEASANT', 'PARTRIDGE', 'QUAIL', 'TOUCAN',
  'APPLE', 'PEAR', 'PEACH', 'APRICOT', 'PLUM', 'CHERRY', 'STRAWBERRY', 'BLACKBERRY', 'BLUEBERRY', 'CURRANT',
  'GRAPE', 'MELON', 'WATERMELON', 'PINEAPPLE', 'BANANA', 'ORANGE', 'LEMON', 'KIWI', 'MANGO', 'PAPAYA',
  'GUAVA', 'LYCHEE', 'COCONUT', 'DATE', 'FIG', 'OLIVE', 'AVOCADO', 'TOMATO', 'CARROT', 'TURNIP',
  'RADISH', 'LEEK', 'ONION', 'GARLIC', 'CELERY', 'FENNEL', 'ASPARAGUS', 'BROCCOLI', 'CABBAGE', 'SPINACH',
  'LETTUCE', 'ENDIVE', 'PEPPER', 'CHILLI', 'CUCUMBER', 'PUMPKIN', 'SQUASH', 'BEAN', 'LENTIL', 'PEA',
  'CORN', 'WHEAT', 'BARLEY', 'OAT', 'RYE', 'RICE', 'WALNUT', 'HAZELNUT', 'ALMOND', 'PISTACHIO',
  'CHESTNUT', 'SUN', 'MOON', 'STAR', 'COMET', 'PLANET', 'GALAXY', 'CLOUD', 'RAIN', 'SNOW',
  'HAIL', 'STORM', 'THUNDER', 'LIGHTNING', 'WIND', 'BREEZE', 'TEMPEST', 'HURRICANE', 'TORNADO', 'DEW',
  'FROST', 'ICE', 'OCEAN', 'SEA', 'LAKE', 'RIVER', 'STREAM', 'BROOK', 'WATERFALL', 'SPRING',
  'POND', 'MARSH', 'BEACH', 'DUNE', 'DESERT', 'OASIS', 'MOUNTAIN', 'HILL', 'VALLEY', 'PLAIN',
  'PLATEAU', 'CLIFF', 'CAVE', 'CANYON', 'VOLCANO', 'GLACIER', 'ICEBERG', 'FOREST', 'JUNGLE', 'SAVANNA',
  'PRAIRIE', 'GROVE', 'TREE', 'OAK', 'BEECH', 'MAPLE', 'BIRCH', 'FIR', 'PINE', 'CEDAR',
  'CYPRESS', 'PALM', 'BAMBOO', 'WILLOW', 'LINDEN', 'PLANE', 'POPLAR', 'ELM', 'ASH', 'WALNUTTREE',
  'FLOWER', 'ROSE', 'TULIP', 'JASMINE', 'LILAC', 'LILY', 'IRIS', 'ORCHID', 'PEONY', 'DAHLIA',
  'LAVENDER', 'MIMOSA', 'SUNFLOWER', 'VIOLET', 'CORNFLOWER', 'CACTUS', 'FERN', 'MOSS', 'IVY', 'REED',
  'CLOVER', 'TABLE', 'CHAIR', 'ARMCHAIR', 'COUCH', 'BED', 'WARDROBE', 'DRESSER', 'DESK', 'SHELF',
  'MIRROR', 'LAMP', 'CANDLE', 'LANTERN', 'CARPET', 'CURTAIN', 'CUSHION', 'PILLOW', 'PLATE', 'BOWL',
  'CUP', 'GLASS', 'CARAFE', 'BOTTLE', 'KNIFE', 'POT', 'KETTLE', 'OVEN', 'FRIDGE', 'BROOM',
  'BUCKET', 'SPONGE', 'SOAP', 'TOWEL', 'BRUSH', 'COMB', 'RAZOR', 'SCISSORS', 'NEEDLE', 'THREAD',
  'BUTTON', 'FABRIC', 'WOOL', 'COTTON', 'SILK', 'LEATHER', 'VELVET', 'HAMMER', 'NAIL', 'SCREW',
  'SCREWDRIVER', 'PLIERS', 'SAW', 'AXE', 'SHOVEL', 'RAKE', 'WHEELBARROW', 'LADDER', 'ROPE', 'CHAIN',
  'PADLOCK', 'KEY', 'LOCK', 'DOOR', 'WINDOW', 'BALCONY', 'STAIRS', 'ROOF', 'WALL', 'BRICK',
  'TILE', 'CHIMNEY', 'GARDEN', 'FENCE', 'GATE', 'FOUNTAIN', 'WELL', 'MILL', 'BARN', 'STABLE',
  'CABIN', 'CHALET', 'CASTLE', 'TOWER', 'BRIDGE', 'ROAD', 'PATH', 'TRAIL', 'VILLAGE', 'TOWN',
  'DISTRICT', 'AVENUE', 'ALLEY', 'SQUARE', 'MARKET', 'SHOP', 'FACTORY', 'WORKSHOP', 'GARAGE', 'HANGAR',
  'LIGHTHOUSE', 'PORT', 'QUAY', 'SHIP', 'BOAT', 'SAILBOAT', 'BARGE', 'CANOE', 'RAFT', 'ANCHOR',
  'SAIL', 'OAR', 'COMPASS', 'MAP', 'GLOBE', 'SUITCASE', 'BAG', 'BASKET', 'CHEST', 'BOX',
  'CARTON', 'PARCEL', 'GIFT', 'RIBBON', 'STRING', 'PAPER', 'NOTEBOOK', 'BOOK', 'NOVEL', 'JOURNAL',
  'LETTER', 'STAMP', 'PENCIL', 'PEN', 'ERASER', 'RULER', 'COMPASSES', 'PAINTBRUSH', 'PAINT', 'PICTURE',
  'STATUE', 'PHOTO', 'CAMERA', 'WATCH', 'CLOCK', 'ALARM', 'GLASSES', 'HAT', 'CAP', 'BEANIE',
  'SCARF', 'GLOVE', 'COAT', 'JACKET', 'SHIRT', 'TROUSERS', 'SKIRT', 'DRESS', 'PYJAMAS', 'BOOT',
  'SANDAL', 'BELT', 'TIE', 'POCKET', 'HANDKERCHIEF', 'UMBRELLA', 'FAN', 'JEWEL', 'RING', 'NECKLACE',
  'BRACELET', 'CROWN', 'TREASURE', 'COIN', 'BANKNOTE', 'PIANO', 'GUITAR', 'VIOLIN', 'FLUTE', 'TRUMPET',
  'DRUM', 'HARP', 'BANJO', 'ORGAN', 'SONG', 'MELODY', 'RHYTHM', 'CONCERT', 'OPERA', 'THEATRE',
  'CINEMA', 'CIRCUS', 'CLOWN', 'JUGGLER', 'ACROBAT', 'MAGICIAN', 'BALLOON', 'TOP', 'DOMINO', 'PUZZLE',
  'RACKET', 'NET', 'STADIUM', 'TRACK', 'PODIUM', 'MEDAL', 'TROPHY', 'FLAG', 'ROCKET', 'AIRPLANE',
  'PROPELLER', 'GLIDER', 'PARACHUTE', 'TRAIN', 'WAGON', 'TRAM', 'SUBWAY', 'BIKE', 'TANDEM', 'MOTORBIKE',
  'SCOOTER', 'CAR', 'TRUCK', 'TRACTOR', 'TRAILER', 'CARAVAN', 'SIREN', 'FIRE', 'FLAME', 'EMBER',
  'SOOT', 'SMOKE', 'COAL', 'CRYSTAL', 'DIAMOND', 'RUBY', 'SAPPHIRE', 'PEARL', 'AMBER', 'COPPER',
  'BRONZE', 'SILVER', 'PLATINUM', 'STEEL', 'LEAD', 'ZINC', 'NICKEL', 'MARBLE', 'GRANITE', 'SLATE',
  'SAND', 'CLAY', 'CHALK', 'FLINT', 'PEBBLE', 'MEADOW', 'THICKET', 'HARBOR', 'LAGOON', 'SUMMIT',
  'RIDGE', 'SLOPE', 'BAY', 'REEF', 'TIDE', 'CORAL', 'SEAWEED', 'BARK', 'TWIG', 'LEAF'
]

const CODE_REGEX = /^([A-Z]{2,12}(?:-[A-Z]{2,12}){0,2})-(\d{4})$/

// Pairing code: one to three words plus four digits, e.g. TIGER-7342.
// opts.words (1-3) or opts.strength ('normal'|'high'|'max') picks how many words.
function generateCode (opts = {}) {
  const byStrength = { normal: 1, high: 2, max: 3 }
  let words = opts.words || byStrength[opts.strength] || 1
  words = Math.min(3, Math.max(1, words | 0))
  const parts = []
  for (let i = 0; i < words; i++) parts.push(WORDS[crypto.randomInt(0, WORDS.length)])
  parts.push(crypto.randomInt(0, 10000).toString().padStart(4, '0'))
  return parts.join('-')
}

// Tolerates spaces, lowercase, a missing dash. Returns the canonical code or null.
function normalizeCode (input) {
  if (typeof input !== 'string') return null
  let s = input.trim().toUpperCase().replace(/\s+/g, '-').replace(/-+/g, '-')
  const noSep = s.match(/^([A-Z]{2,12})(\d{4})$/)
  if (noSep) s = `${noSep[1]}-${noSep[2]}`
  return CODE_REGEX.test(s) ? s : null
}

function deriveMaster (secret) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(b4a.from(secret, 'utf8'), APP_SALT, 32, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

// Derives the DHT topic and the auth (HMAC) key from the code, via a slow
// scrypt pass then HKDF. An optional passphrase is folded into the input, so
// both the topic and the auth key depend on it. Without a passphrase the
// result matches the plain-code version.
async function deriveSecrets (code, passphrase = '') {
  const secret = passphrase ? `${code}\n${passphrase}` : code
  const master = await deriveMaster(secret)
  const topic = b4a.from(crypto.hkdfSync('sha256', master, APP_SALT, b4a.from('neodrop/topic'), 32))
  const authKey = b4a.from(crypto.hkdfSync('sha256', master, APP_SALT, b4a.from('neodrop/auth'), 32))
  return { topic, authKey }
}

module.exports = { WORDS, generateCode, normalizeCode, deriveSecrets, CODE_REGEX }
