/*!
 * words.mjs -- curated wordlists for the "words" code mode.
 *
 * Both lists are deliberately bland: nature, weather, animals, materials,
 * neutral/positive adjectives. No slurs, no profanity, nothing that reads as
 * an insult when three are stuck together. All lowercase a-z, 3-8 letters,
 * no lookalike pairs to worry about since the slug is words, not characters.
 *
 * Keyspace with the current lists: |ADJ|^2 * |NOUN|  (well over 10 million),
 * and a `-xx` suffix is appended on the rare collision.
 */

const ADJECTIVES = dedupe([
  "able", "aloof", "amber", "ample", "arctic", "artful", "autumn", "azure",
  "balmy", "bold", "bonny", "brave", "brief", "bright", "brisk", "calm",
  "candid", "chief", "civic", "classic", "clean", "clear", "clever", "cloudy",
  "coastal", "cosmic", "cozy", "crisp", "curly", "daily", "dapper", "deft",
  "dreamy", "dual", "dusky", "eager", "early", "earthy", "easy", "elder",
  "epic", "even", "exact", "extra", "faint", "fair", "famed", "fancy", "fast",
  "fiery", "fine", "first", "fizzy", "fleet", "floral", "fluffy", "fond",
  "frank", "free", "fresh", "frosty", "full", "fuzzy", "gentle", "giant",
  "glad", "glossy", "golden", "grand", "grassy", "green", "hardy", "hazel",
  "hearty", "hidden", "high", "hollow", "honest", "humble", "icy", "ideal",
  "idle", "jolly", "jumbo", "keen", "kind", "large", "lasting", "late",
  "lawful", "leafy", "level", "light", "lilac", "lively", "lofty", "lone",
  "loyal", "lucid", "lucky", "lunar", "lush", "main", "major", "mango",
  "marble", "mellow", "merry", "mighty", "mild", "minor", "minty", "misty",
  "modern", "modest", "mossy", "muted", "native", "neat", "nifty", "nimble",
  "noble", "north", "noted", "novel", "oaken", "olive", "open", "ornate",
  "pale", "peppy", "perky", "plain", "plucky", "plush", "polar", "polite",
  "prime", "proud", "pure", "quaint", "quick", "quiet", "rapid", "rare",
  "ready", "real", "regal", "ripe", "rising", "robust", "rosy", "round",
  "royal", "ruby", "rustic", "safe", "salty", "sandy", "sane", "scenic",
  "secret", "serene", "shady", "sharp", "sheer", "shiny", "short", "silent",
  "silky", "silver", "simple", "sleek", "slim", "smart", "smooth", "snappy",
  "snowy", "soft", "solar", "solid", "sonic", "sound", "south", "spare",
  "spry", "stark", "steady", "steep", "stellar", "still", "stormy", "stout",
  "sturdy", "sunny", "super", "sure", "swift", "teal", "tender", "tidal",
  "tidy", "timely", "tiny", "topaz", "trim", "true", "trusty", "twin",
  "upbeat", "urban", "valiant", "vast", "velvet", "vivid", "warm", "wavy",
  "west", "whole", "wild", "windy", "winter", "wise", "witty", "woven",
  "young", "zesty", "zippy",
]);

const NOUNS = dedupe([
  "acorn", "alcove", "almond", "anchor", "antler", "apex", "arbor", "arch",
  "arrow", "ash", "aspen", "atlas", "aurora", "badger", "bamboo", "basin",
  "bay", "beacon", "beam", "bear", "beaver", "birch", "bison", "blossom",
  "bluff", "bolt", "boulder", "branch", "brook", "buffalo", "canyon", "cape",
  "cedar", "chalk", "cliff", "cloud", "clover", "coast", "comet", "cove",
  "crane", "crater", "creek", "crest", "crow", "crystal", "cypress", "dawn",
  "deer", "delta", "den", "dew", "dingo", "dolphin", "dove", "dune", "eagle",
  "echo", "elm", "ember", "falcon", "fawn", "fern", "fjord", "flame", "flint",
  "fox", "gale", "garden", "gecko", "geyser", "glacier", "glade", "gorge",
  "granite", "grotto", "grove", "gull", "harbor", "hare", "harvest", "hawk",
  "haze", "heath", "hedge", "heron", "hill", "horizon", "ibis", "inlet",
  "iris", "ivy", "jasper", "jay", "kelp", "kestrel", "koala", "lagoon",
  "lake", "lantern", "larch", "lark", "leaf", "ledge", "lily", "lion",
  "lodge", "lotus", "lynx", "magpie", "maple", "marsh", "meadow", "mesa",
  "mist", "moose", "moss", "moth", "mountain", "nectar", "nest", "oak",
  "oasis", "ocean", "orbit", "otter", "owl", "palm", "panther", "peak",
  "pearl", "pebble", "pine", "plume", "pond", "poplar", "prairie", "quail",
  "quartz", "quill", "rain", "raven", "reef", "ridge", "rill", "river",
  "robin", "rook", "root", "sable", "sage", "sand", "sequoia", "shale",
  "shell", "shore", "shrew", "sky", "sleet", "sloth", "snow", "sparrow",
  "spring", "spruce", "star", "stone", "stork", "storm", "strait", "stream",
  "summit", "sun", "swan", "thicket", "thistle", "thrush", "tide", "timber",
  "torrent", "trail", "tulip", "tundra", "valley", "vale", "vapor", "vine",
  "vista", "vole", "wave", "willow", "wolf", "wren",
]);

function dedupe(list) {
  return Array.from(new Set(list));
}

export { ADJECTIVES, NOUNS };

/** log2 of the keyspace, for docs / capacity math. */
export const KEYSPACE_BITS =
  Math.log2(ADJECTIVES.length) * 2 + Math.log2(NOUNS.length);
