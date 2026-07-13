const LEET_MAP = {
  '1': 'i', '!': 'i', '|': 'i',
  '0': 'o',
  '3': 'e',
  '4': 'a', '@': 'a',
  '5': 's', '$': 's',
  '7': 't', '+': 't',
  '8': 'b',
  '9': 'g',
  '2': 'z',
};

const BLOCKLIST = {
  slurs: [
    'nigger', 'nigga', 'kike', 'spic', 'chink', 'gook', 'wetback',
    'raghead', 'beaner', 'coon',
    'faggot', 'fag', 'dyke', 'tranny', 'shemale',
    'retard', 'retarded', 'mongoloid', 'spaz', 'spastic',
    'nazi', 'hitler', 'kkk',
    'sandnigger',
  ],
  sexual_explicit: [
    'fuck', 'motherfucker', 'motherfuck', 'fuckface', 'fuckhead', 'fucktard',
    'cunt', 'cock', 'dick', 'pussy', 'twat',
    'blowjob', 'handjob',
    'bukkake', 'cum', 'cumshot', 'cummer',
    'dildo', 'vibrator', 'buttplug',
    'gangbang', 'orgy', 'masturbate', 'masterbate', 'jerkoff',
    'porno', 'pornography', 'pornstar', 'hentai', 'xrated',
    'penis', 'vagina', 'clitoris', 'clit', 'testicle', 'scrotum', 'anus',
    'labia', 'vulva', 'urethra', 'foreskin', 'phallus', 'taint', 'gooch',
    'incest', 'pedophile', 'pedophilia', 'pedo', 'rape', 'rapist',
    'sexual', 'hardcore', 'ejaculate', 'semen', 'sperm',
    'erection', 'fellatio', 'cunnilingus', 'rimjob',
    'doggystyle', 'missionary', 'nutted', 'bustinganut',
  ],
  insults: [
    'asshole', 'asshat', 'asswipe', 'dumbass', 'jackass', 'fatass',
    'smartass', 'wiseass', 'badass', 'hardass', 'lazyass',
    'shithead', 'shitter', 'shitbag', 'skank', 'douche',
    'cocksucker', 'bastard', 'bitch', 'slut', 'whore',
    'cuck', 'cuckold', 'pimp',
    'motherfucker', 'fuckboy', 'fuckboi', 'dipshit', 'dickhead',
    'knobhead', 'bellend', 'wanker', 'tosser', 'nonce',
    'prick', 'bollocks', 'bugger', 'wankstain',
  ],
  moderate: [
    'shit', 'ass', 'piss',
    'damn', 'goddamn',
    'hell', 'crap', 'suck',
  ],
  drugs: [
    'weed', 'cocaine', 'heroin', 'meth', 'crack',
    'marijuana', 'lsd', 'ecstasy', 'molly',
    'opium', 'fentanyl', 'ketamine',
    'shrooms',
  ],
  obfuscation_variants: [
    'fuk', 'fck', 'f*k', 'fkc', 'phuck', 'phuk', 'fack',
    'sht', 'sh1t', 'sh!t', 'shyt',
    'b!tch', 'b1tch', 'btch', 'biotch',
    'azz', 'a$$', 'arse',
    'd!ck', 'd1ck', 'dik',
    'c*nt', 'cnt', 'kunt',
    'p*ssy', 'pssy', 'puzzy',
    'c*ck', 'cck', 'kock',
    'b@lls', 'bawls', 'ballz',
    't!ts', 't1ts', 'titties', 'boobies',
    'f@ggot', 'f@gg0t',
    'n1gger', 'n!gger',
    'mothafucka',
  ]
};

const FALSE_POSITIVES = new Set([
  'class', 'grass', 'pass', 'bass', 'glass', 'brass', 'mass',
  'assassin', 'assassinate', 'assume', 'assumption',
  'hello', 'shell', 'fellowship', 'hellenic',
  'scunthorpe',
  'weeds', 'tweed',
  'peacock', 'cocktail', 'cockroach',
  'sextant', 'sexton',
  'analysis', 'analyst',
  'coconut', 'cocoa',
  'dictate', 'dictator',
  'peninsula',
  'cumulative', 'cucumber',
  'shuttle', 'shut',
  'essex', 'essence',
  'hitchcock',
  'therapist',
  'saskatchewan',
  'light', 'night', 'right', 'tight', 'sight', 'might', 'fight',
  'homestead', 'homesteader',
  'title', 'tittle',
]);

function normalize(text) {
  let s = text.toLowerCase().trim();

  for (const [leet, letter] of Object.entries(LEET_MAP)) {
    while (s.includes(leet)) {
      s = s.replace(leet, letter);
    }
  }

  // Strip separator characters that are used for obfuscation
  // f.u.c.k → fuck, f u c k → fuck, f-u-c-k → fuck, f_u_c_k → fuck
  s = s.replace(/[.\-_* ,]/g, '');

  // Collapse repeated characters: runs of 3+ → cap at 2
  // "fuuuuck" → "fuuck", "aaaaassssss" → "aass"
  s = s.replace(/(.)\1{2,}/g, '$1$1');

  return s;
}

function hasProfanity(text) {
  if (!text || typeof text !== 'string') return false;

  const stripped = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (FALSE_POSITIVES.has(stripped)) return false;

  const norm = normalize(text);

  // Aggressively collapse ALL repeats for dictionary lookup
  // "heeeeeell" → "hel", "fuuuuck" → "fuk", "assss" → "as"
  const dict = norm.replace(/(.)\1+/g, '$1');

  for (const category of Object.keys(BLOCKLIST)) {
    for (const word of BLOCKLIST[category]) {
      const clean = word.replace(/[^a-z0-9]/g, '');
      if (clean.length < 2) continue;

      const cleanDict = clean.replace(/(.)\1+/g, '$1');

      // Exact match on either form
      if (norm === clean || dict === cleanDict) return true;

      // ≥ 4 chars: substring match on either form
      if (clean.length >= 4) {
        if (norm.includes(clean) || dict.includes(cleanDict)) return true;
        continue;
      }

      // 3-char words: only flag short inputs where the word is clearly intentional
      if (clean.length === 3) {
        if (norm.length <= clean.length + 4 && norm.includes(clean)) return true;
        if (dict.length <= cleanDict.length + 4 && dict.includes(cleanDict)) return true;
      }
    }
  }

  return false;
}

module.exports = {
  hasProfanity,
  BLOCKLIST_COUNT: Object.values(BLOCKLIST).reduce((sum, arr) => sum + arr.length, 0),
  CATEGORIES: Object.keys(BLOCKLIST).length
};
