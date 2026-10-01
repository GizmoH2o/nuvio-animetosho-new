'use strict';

/* AnimeTosho for Nuvio.
 *
 * Nuvio passes (tmdbId, mediaType, season, episode) with TMDB numbering, while
 * AnimeTosho indexes releases per AniDB entry (one entry per season/cour).
 * Pipeline for a TV request:
 *   1. AniMap maps the TMDB id to a *franchise* of AniDB ids (movies, OVAs and
 *      specials included, and no season information).
 *   2. Each AniDB record (type, start date, episode count) is fetched so movies
 *      and specials can be dropped and the TV entries ordered chronologically;
 *      the requested season is resolved to one entry and a relative episode.
 *   3. AnimeTosho is queried per entry with the episode number in the query, so
 *      the right release is never pushed off a result page by popular episodes.
 *   4. AnimeTosho links most files to an AniDB episode id (eid). When the target
 *      episode's eid can be established, it is used as ground truth.
 *   5. Every candidate must still pass strict title checks (season and episode).
 * When in doubt a release is rejected: no result beats a wrong result.
 */
var PROVIDER_NAME = '🧲 AnimeTosho';
var ANIMAP_API = 'https://animap.id/api/map/tmdb/';
var ANIMAP_ANIDB_API = 'https://animap.id/api/anidb/';
// Same feed the working Seanime provider uses first; the legacy host is a fallback.
var FEED_URLS = ['https://animetosho.xyz/feed/json', 'https://feed.animetosho.org/json'];
var PAGE_SIZE = 100;
var MAX_RESULTS = 50;
var MAX_AIDS = 10;
var MAX_SEEDERS = 100000; // AnimeTosho occasionally reports impossible counts
var TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce'
];

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */

function fetchJson(url, options) {
  // Nuvio's fetch implementation is deliberately minimal: only use json().
  return fetch(url, options || {}).then(function (response) { return response.json(); });
}

function getRuntimeSettings() {
  try {
    if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS) return global.SCRAPER_SETTINGS;
    if (typeof window !== 'undefined' && window.SCRAPER_SETTINGS) return window.SCRAPER_SETTINGS;
  } catch (error) {}
  return {};
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function buildQuery(params) {
  return Object.keys(params).filter(function (key) {
    return params[key] !== undefined && params[key] !== null && params[key] !== '';
  }).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]));
  }).join('&');
}

function cleanTorrent(torrent) {
  if (Number(torrent.seeders) > MAX_SEEDERS) torrent.seeders = 0;
  if (Number(torrent.leechers) > MAX_SEEDERS) torrent.leechers = 0;
  return torrent;
}

// One feed page. A host that errors or returns a non-array falls through to the next.
function fetchPage(params, page) {
  var query = buildQuery({
    cat: '2020', aid: params.aid, eid: params.eid, q: params.q,
    order: params.order || 'seeders-d', limit: PAGE_SIZE, page: page
  });
  function attempt(index) {
    if (index >= FEED_URLS.length) return Promise.resolve([]);
    return fetchJson(FEED_URLS[index] + '?' + query).then(function (items) {
      if (!Array.isArray(items)) throw new Error('Unexpected AnimeTosho payload');
      return items.map(cleanTorrent);
    }).catch(function () { return attempt(index + 1); });
  }
  return attempt(0);
}

function fetchTorrents(params, maxPages) {
  var results = [];
  function next(page) {
    return fetchPage(params, page).then(function (items) {
      results = results.concat(items);
      if (items.length < PAGE_SIZE || page >= maxPages) return results;
      return next(page + 1);
    });
  }
  return next(1);
}

function flattenPages(pages) {
  var torrents = [];
  pages.forEach(function (page) { torrents = torrents.concat(page); });
  return torrents;
}

/* ------------------------------------------------------------------ */
/* AniMap                                                              */
/* ------------------------------------------------------------------ */

function getAnime(tmdbId, isSeries) {
  return fetchJson(ANIMAP_API + encodeURIComponent(String(tmdbId))).then(function (anime) {
    if (Array.isArray(anime)) anime = anime[0];
    if (!anime || !anime.title) throw new Error('No AniMap entry for TMDB ' + tmdbId);

    // AniMap matches a TMDB id in both the tv and movie namespaces. If the only
    // reference to our id is the other kind, this entry is for a different title.
    var id = Number(tmdbId);
    var wanted = isSeries ? 'tv' : 'movie';
    var ours = toArray(anime.tmdb_id).filter(function (ref) {
      return ref && Number(typeof ref === 'object' ? ref.id : ref) === id;
    });
    if (ours.length && !ours.some(function (ref) { return typeof ref !== 'object' || ref.type === wanted; })) {
      throw new Error('TMDB ' + tmdbId + ' is not a ' + wanted + ' entry in AniMap');
    }

    return {
      titles: unique([anime.title].concat(toArray(anime.synonyms))).slice(0, 4),
      aids: unique(toArray(anime.anidb_id).map(Number).filter(function (aid) { return aid > 0; }))
    };
  });
}

// AniDB record: type, first air date, episode count, TMDB references. A record
// that cannot be fetched is kept as "unknown" rather than silently dropped.
function fetchAidRecord(aid) {
  return fetchJson(ANIMAP_ANIDB_API + encodeURIComponent(String(aid))).then(function (record) {
    record = record || {};
    return {
      aid: aid,
      type: String(record.type || ''),
      start: String(record.startdate || (record.startyear ? record.startyear + '-12-31' : '')),
      count: Number(record.episodecount) || 0,
      tmdb: toArray(record.tmdb_ids).filter(function (ref) { return ref && typeof ref === 'object'; })
    };
  }).catch(function () {
    return { aid: aid, type: '', start: '', count: 0, tmdb: [] };
  });
}

function getEntries(aids) {
  return Promise.all(aids.slice(0, MAX_AIDS).map(fetchAidRecord)).then(function (entries) {
    return entries.sort(function (left, right) {
      var a = left.start || '9999-99-99';
      var b = right.start || '9999-99-99';
      return a < b ? -1 : a > b ? 1 : left.aid - right.aid;
    });
  });
}

// AniDB types: "TV Series", "Web", "Movie", "OVA", "TV Special", "Music Video", "Other".
function isEpisodicType(type) {
  return !/movie|ova|oad|special|music|other/i.test(String(type || ''));
}

function isMovieType(type) { return /movie/i.test(String(type || '')); }

// Drop entries that AniDB ties to a *different* TMDB tv show.
function belongsToShow(entry, tmdbId) {
  var tvRefs = entry.tmdb.filter(function (ref) { return ref.type === 'tv'; });
  return !tvRefs.length || tvRefs.some(function (ref) { return Number(ref.id) === Number(tmdbId); });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function toInt(value, fallback) {
  var number = parseInt(value, 10);
  return isFinite(number) && number >= 0 ? number : fallback;
}

function getStreams(tmdbId, mediaType, season, episode) {
  var request = {
    tmdbId: Number(tmdbId),
    isSeries: mediaType === 'tv' || mediaType === 'series',
    // Do not use `season || 1`: season 0 (specials) is a valid request.
    season: toInt(season, 1),
    episode: toInt(episode, 1),
    includeBatches: getRuntimeSettings().includeBatches !== false
  };
  return getAnime(tmdbId, request.isSeries).then(function (anime) {
    return getEntries(anime.aids).then(function (entries) {
      return request.isSeries ? resolveSeries(anime, entries, request) : resolveMovie(entries);
    });
  }).then(function (torrents) {
    return torrents.slice(0, MAX_RESULTS).map(toNuvioStream);
  }).catch(function (error) {
    console.error('[AnimeTosho] ' + (error && error.message ? error.message : String(error)));
    return [];
  });
}

/* ------------------------------------------------------------------ */
/* Movies                                                              */
/* ------------------------------------------------------------------ */

function resolveMovie(entries) {
  var movies = entries.filter(function (entry) { return isMovieType(entry.type); });
  var targets = movies.length ? movies : entries;
  return Promise.all(targets.map(function (entry) {
    return fetchTorrents({ aid: entry.aid }, 3);
  })).then(function (pages) {
    return sortAndFilter(dedupe(flattenPages(pages)));
  });
}

/* ------------------------------------------------------------------ */
/* TV                                                                  */
/* ------------------------------------------------------------------ */

function resolveSeries(anime, entries, request) {
  var tv = request.season === 0 ? entries : entries.filter(function (entry) {
    return isEpisodicType(entry.type) && belongsToShow(entry, request.tmdbId);
  });
  if (!tv.length) return searchByTitles(anime, request);

  return searchEntries(tv, request).then(function (pool) {
    var torrents = dedupe(pool);
    var plan = buildPlan(tv, toEntries(torrents), request);
    var eid = findTargetEid(toEntries(torrents), plan);
    if (!eid) return finish(torrents, plan);
    plan.eid = eid;
    // The eid is AniDB's own episode id: this returns every release of exactly
    // this episode, including ones whose titles carry no parseable number.
    return fetchTorrents({ eid: eid }, 2).then(function (extra) {
      return finish(dedupe(torrents.concat(extra)), plan);
    });
  });
}

// Per entry: releases whose title mentions the episode, plus (optionally) the
// largest releases, which is where batches live. Narrowing by episode keeps the
// target from falling outside the first result pages of a popular entry.
function searchEntries(tv, request) {
  var requests = [];
  tv.forEach(function (entry, index) {
    var numbers = candidateNumbers(tv, index, request.episode);
    requests.push(fetchTorrents({
      aid: entry.aid, q: buildEpisodeQuery(numbers, request.season, request.episode), order: 'seeders-d'
    }, 2));
    if (request.includeBatches) requests.push(fetchTorrents({ aid: entry.aid, order: 'size-d' }, 1));
  });
  return Promise.all(requests).then(flattenPages);
}

// Title search for shows AniMap knows by name only. No AniDB entry means no
// season mapping, so only releases that name the season themselves can match.
function searchByTitles(anime, request) {
  var numbers = [request.episode];
  var suffix = buildEpisodeQuery(numbers, request.season, request.episode);
  return Promise.all(anime.titles.map(function (title) {
    var clean = String(title).replace(/-/g, ' ').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return Promise.resolve([]);
    return fetchTorrents({ q: '"' + clean + '" ' + suffix, order: 'seeders-d' }, 2);
  })).then(function (pages) {
    var torrents = dedupe(flattenPages(pages));
    return finish(torrents, { season: request.season, episode: request.episode, target: null, eid: 0, includeBatches: request.includeBatches });
  });
}

// Episode numbers that could refer to the requested TMDB episode inside this
// entry: the number itself, and the number left after subtracting the earlier
// entries (TMDB often lumps split cours into one season).
function candidateNumbers(entries, index, episode) {
  var numbers = [episode];
  var count = entries[index].count;
  var skipped = 0;
  for (var i = index - 1; i >= 0; i--) {
    if (!entries[i].count) break;
    skipped += entries[i].count;
    var number = episode - skipped;
    if (number < 1) break;
    if ((!count || number <= count) && numbers.indexOf(number) === -1) numbers.push(number);
  }
  return numbers;
}

// AnimeTosho boolean syntax, as used by the Seanime provider:
// ("05"|"5"|"e5"|"ep5"|"e05"|"s02e05"|"s2e5")
function buildEpisodeQuery(numbers, season, episode) {
  var terms = [];
  function add(term) { if (terms.indexOf(term) === -1) terms.push(term); }
  numbers.forEach(function (number) {
    add('"' + pad2(number) + '"');
    add('"' + number + '"');
    add('"e' + number + '"');
    add('"ep' + number + '"');
    add('"e' + pad2(number) + '"');
  });
  add('"s' + pad2(season) + 'e' + pad2(episode) + '"');
  add('"s' + season + 'e' + episode + '"');
  return '(' + terms.join('|') + ')';
}

function toEntries(torrents) {
  return torrents.map(function (torrent) {
    return { torrent: torrent, release: parseRelease(torrent.title), aid: Number(torrent.anidb_aid) || 0 };
  });
}

function dedupe(torrents) {
  return uniqueBy(torrents, function (torrent) {
    return torrent.info_hash || torrent.magnet_uri || torrent.torrent_url;
  });
}

function sortAndFilter(torrents) {
  return torrents
    .filter(function (torrent) { return Number(torrent.seeders) > 0; })
    .sort(compareTorrents);
}

function finish(torrents, plan) {
  return sortAndFilter(toEntries(torrents).filter(function (entry) {
    return matchesRequest(entry, plan);
  }).map(function (entry) { return entry.torrent; }));
}

/* ------------------------------------------------------------------ */
/* Season resolution                                                   */
/* ------------------------------------------------------------------ */

function buildPlan(tv, entries, request) {
  var target = null;
  if (request.season > 0) {
    target = resolveTarget(tv, computeAidSeasons(entries), request.season, request.episode);
  }
  return {
    season: request.season,
    episode: request.episode,
    includeBatches: request.includeBatches,
    target: target, // { aid, rel } or null
    eid: 0
  };
}

// Which season does each AniDB entry hold? Releases that name their season
// (S02E03, "2nd Season") vote for the entry they are filed under.
function computeAidSeasons(entries) {
  var votes = {};
  entries.forEach(function (entry) {
    if (!entry.aid) return;
    var season = singleSeason(entry.release);
    if (season === null || season === 0) return;
    votes[entry.aid] = votes[entry.aid] || {};
    votes[entry.aid][season] = (votes[entry.aid][season] || 0) + 1;
  });
  var aidSeasons = {};
  Object.keys(votes).forEach(function (aid) {
    var best = null;
    Object.keys(votes[aid]).forEach(function (key) {
      var season = Number(key);
      var counts = votes[aid];
      if (best === null || counts[season] > counts[best] || (counts[season] === counts[best] && season < best)) best = season;
    });
    aidSeasons[aid] = best;
  });
  return aidSeasons;
}

// Entries are in airing order, so season N is normally the Nth TV entry. Votes
// from season-marked releases override that, and an entry that is known to hold
// another season is never used. If the season spans several entries (split
// cours) the episode is walked forward through their episode counts.
function resolveTarget(tv, aidSeasons, season, episode) {
  var chain = tv.filter(function (entry) { return aidSeasons[entry.aid] === season; });
  var i;
  if (!chain.length) {
    var start = season - 1;
    if (start < 0 || start >= tv.length) return null;
    for (i = start; i < tv.length; i++) {
      var voted = aidSeasons[tv[i].aid];
      if (voted !== undefined && voted !== season) break;
      chain.push(tv[i]);
    }
  }
  var rel = episode;
  for (i = 0; i < chain.length; i++) {
    var count = chain[i].count;
    if (!count || rel <= count) return { aid: chain[i].aid, rel: rel };
    rel -= count;
  }
  return null;
}

// AniDB episode id of the target episode, established from single-file releases
// of the target entry whose titles unambiguously name the episode. Only trusted
// when one id clearly wins.
function findTargetEid(entries, plan) {
  if (!plan.target || plan.season === 0) return 0;
  var counts = {};
  entries.forEach(function (entry) {
    var eid = Number(entry.torrent.anidb_eid) || 0;
    if (!eid || entry.aid !== plan.target.aid || fileCount(entry) !== 1) return;
    if (!matchesRequest(entry, plan)) return;
    counts[eid] = (counts[eid] || 0) + 1;
  });
  var ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  if (!ranked.length) return 0;
  if (ranked.length > 1 && counts[ranked[0]] === counts[ranked[1]]) return 0;
  return Number(ranked[0]);
}

/* ------------------------------------------------------------------ */
/* Release-title parsing                                               */
/* ------------------------------------------------------------------ */

var RE = {
  // S02E03, S02E03-E05, S02E03E04, S02 E03
  seasonEpisode: /\bS(\d{1,2})[ ._-]*E(\d{1,4})(?:v\d+)?(?:[ ._]*(?:-|~|to)[ ._]*E?(\d{1,4})|[ ._-]?E(\d{1,4}))?/gi,
  // 2x03, 2x03-05
  nxm: /\b(\d{1,2})x(\d{1,3})(?:v\d+)?(?:[ ._]*(?:-|~)[ ._]*(\d{1,3}))?(?!\d)/gi,
  // S01-S03 and "Seasons 1-3" (the second S / plural is required so that
  // "S2 - 03", meaning season 2 episode 3, is never read as a season range)
  seasonRangeS: /\bS(\d{1,2})[ ._]*(?:-|~|to)[ ._]*S(\d{1,2})\b/gi,
  seasonRangeWord: /\bSeasons[ ._]*(\d{1,2})[ ._]*(?:-|~|to|&|and)[ ._]*(\d{1,2})\b/gi,
  season: /\bS(\d{1,2})\b/gi,
  seasonWord: /\bSeason[ ._]*(\d{1,2})\b/gi,
  seasonOrdinal: /\b(\d{1,2})(?:st|nd|rd|th)[ ._]*Season\b/gi,
  // Episode ranges. The last two capture groups are always (from, to).
  rangeBracketed: /[\[\(]\s*(?:E|EP|Episodes?)?[ ._]*(\d{1,4})(?:v\d+)?\s*(?:-|~|to|through)\s*(?:E|EP)?[ ._]*(\d{1,4})(?:v\d+)?\s*(?:END|FIN)?\s*[\]\)]/gi,
  rangeTight: /(?:^|[\s\[\(_.])(?:E|EP)?(\d{1,4})(?:v\d+)?(?:-|~)(?:E|EP)?(\d{1,4})(?:v\d+)?(?=$|[\s\]\)_.,])/gi,
  rangeWord: /(?:^|[\s\[\(_.])(?:E|EP)?(\d{1,4})(?:v\d+)?[ ._]*(?:~|to|through)[ ._]*(?:E|EP)?(\d{1,4})(?:v\d+)?(?=$|[\s\]\)_.,])/gi,
  rangeLabelled: /\b(?:EPS?|Episodes?)[ ._]*(\d{1,4})[ ._]*(?:-|~|to|through)[ ._]*(\d{1,4})\b/gi,
  rangeSpaced: /(?:^|[\s\[\(_.])(\d{1,4})[ ._]+-[ ._]+(\d{1,4})(?=$|[\s\]\)_.,])/gi,
  // Single episodes
  labelled: /\b(?:EP|E|Episode)[ ._]*(\d{1,4})(?:v\d+)?(?!\d)/gi,
  dashed: /(?:^|[\s\]\)])-[ ._]*(\d{1,4})(?:v\d+)?(?=$|[\s\[\(\]\)_.,])/gi,
  bracketed: /[\[\(]\s*(\d{1,4})(?:v\d+)?\s*(?:END|FIN)?\s*[\]\)]/gi,
  // Weakest signal ("Show 05 [1080p]"); only used when nothing else matched.
  padded: /\s(\d{2,4})(?:v\d+)?(?=\s*(?:[\[\(]|$))/gi,
  // Flags
  batch: /\b(?:batch|complete(?:d)?|collection|box\s*set|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season))\b|全集|合集|全巻|一挙|완결/i,
  extra: /\b(?:OVAs?|OADs?|NCOP|NCED|Creditless|Trailer)\b/i,
  special: /\b(?:OVAs?|OADs?|ONAs?|Specials?|SP)\b/i
};

// Remove tokens whose digits would otherwise be mistaken for episode numbers.
function stripNoise(title) {
  return String(title || '')
    .replace(/\[[0-9a-f]{8}\]/gi, ' ')
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ')
    .replace(/\b(?:2160|1440|1080|720|576|480)[pi]\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b[xh][ .]?26[45]\b/gi, ' ')
    .replace(/\b\d{1,2}[ -]?bits?\b/gi, ' ')
    .replace(/\b(?:aac|ac3|eac3|flac|dts|opus|ddp?|truehd)[ .]?\d(?:\.\d)?\b/gi, ' ')
    .replace(/\b[257]\.[01]\b/g, ' ')
    .replace(/\s+/g, ' ');
}

// Runs handler on every match, then blanks the matches out of the text so a
// later pattern cannot read the same digits a second time.
function consume(text, regex, handler) {
  var match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    handler(match);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  regex.lastIndex = 0;
  return text.replace(regex, ' ');
}

function parseRelease(rawTitle) {
  var title = String(rawTitle || '');
  var text = ' ' + stripNoise(title) + ' ';
  var release = {
    explicit: [],   // {season, from, to} from SxxExx / NxM
    seasons: [],    // seasons named without an episode (S2, Season 2, 2nd Season, S01-S03)
    episodes: [],   // single episode numbers
    ranges: [],     // {from, to} episode ranges
    batch: RE.batch.test(title),
    extra: RE.extra.test(title),
    special: RE.special.test(title)
  };

  function addExplicit(match) {
    var from = Number(match[2]);
    var to = Number(match[3] || match[4] || match[2]);
    release.explicit.push({ season: Number(match[1]), from: Math.min(from, to), to: Math.max(from, to) });
  }
  function addSeason(value) {
    var number = Number(value);
    if (release.seasons.indexOf(number) === -1) release.seasons.push(number);
  }
  function addSeasonRange(match) {
    var from = Number(match[1]);
    var to = Number(match[2]);
    if (to < from || to - from > 50) return;
    for (var s = from; s <= to; s++) addSeason(s);
  }
  function addRange(match) {
    var from = Number(match[match.length - 2]);
    var to = Number(match[match.length - 1]);
    if (to > from) release.ranges.push({ from: from, to: to });
  }
  function addEpisode(match) { release.episodes.push(Number(match[1])); }

  text = consume(text, RE.seasonEpisode, addExplicit);
  text = consume(text, RE.nxm, addExplicit);
  text = consume(text, RE.seasonRangeS, addSeasonRange);
  text = consume(text, RE.seasonRangeWord, addSeasonRange);
  text = consume(text, RE.season, function (m) { addSeason(m[1]); });
  text = consume(text, RE.seasonWord, function (m) { addSeason(m[1]); });
  text = consume(text, RE.seasonOrdinal, function (m) { addSeason(m[1]); });

  text = consume(text, RE.rangeBracketed, addRange);
  text = consume(text, RE.rangeTight, addRange);
  text = consume(text, RE.rangeWord, addRange);
  text = consume(text, RE.rangeLabelled, addRange);
  // "01 - 12" is ambiguous with "Title 2 - 03"; only trust it for batches.
  if (release.batch) text = consume(text, RE.rangeSpaced, addRange);

  text = consume(text, RE.labelled, addEpisode);
  text = consume(text, RE.dashed, addEpisode);
  text = consume(text, RE.bracketed, addEpisode);
  if (!release.explicit.length && !release.ranges.length && !release.episodes.length) {
    consume(text, RE.padded, addEpisode);
  }

  // "Show.S01.1080p.BluRay": a season with no episode information is a season pack.
  if (release.seasons.length && !release.explicit.length && !release.ranges.length && !release.episodes.length) {
    release.batch = true;
  }
  return release;
}

// Season this release explicitly names, or null when absent or ambiguous.
function singleSeason(release) {
  if (release.extra) return null;
  var seasons = [];
  release.explicit.forEach(function (item) {
    if (seasons.indexOf(item.season) === -1) seasons.push(item.season);
  });
  if (!release.explicit.length) seasons = release.seasons;
  return seasons.length === 1 ? seasons[0] : null;
}

/* ------------------------------------------------------------------ */
/* Season / episode matching                                           */
/* ------------------------------------------------------------------ */

function fileCount(entry) { return Number(entry.torrent.num_files) || 1; }

function coversEpisode(release, numbers, includeBatches, isBatch) {
  var i;
  var j;
  for (i = 0; i < numbers.length; i++) {
    if (release.episodes.indexOf(numbers[i]) !== -1) return true;
  }
  if (!includeBatches) return false;
  for (i = 0; i < release.ranges.length; i++) {
    for (j = 0; j < numbers.length; j++) {
      if (numbers[j] >= release.ranges[i].from && numbers[j] <= release.ranges[i].to) return true;
    }
  }
  // A release that names other episodes or ranges is not a match; only an
  // unnumbered batch / season pack can cover an episode it does not list.
  if (release.ranges.length || release.episodes.length) return false;
  return isBatch;
}

function matchesRequest(entry, plan) {
  var release = entry.release;
  var season = plan.season;
  var episode = plan.episode;
  var includeBatches = plan.includeBatches;
  var isBatch = release.batch || fileCount(entry) > 1;
  var i;

  if (season !== 0 && release.extra) return false;

  // 1. Explicit SxxExx / NxM numbering is authoritative: both must agree.
  if (release.explicit.length) {
    for (i = 0; i < release.explicit.length; i++) {
      var item = release.explicit[i];
      if (item.season !== season || episode < item.from || episode > item.to) continue;
      if (item.from === item.to || includeBatches) return true;
    }
    return false;
  }

  // 2. Specials have no AniDB season mapping: they must say so themselves.
  if (season === 0) {
    if (release.seasons.indexOf(0) === -1 && !release.special) return false;
    return coversEpisode(release, [episode], includeBatches, isBatch);
  }

  // 3. A release that names a season must name the requested one; one that
  //    does not must come from the AniDB entry resolved for this season.
  var marked = release.seasons.length > 0;
  if (marked && release.seasons.indexOf(season) === -1) return false;
  var onTarget = !!plan.target && entry.aid === plan.target.aid;
  if (!marked && !onTarget) return false;

  // 4. AniDB's own episode link beats any title guess for single-file releases.
  var eid = Number(entry.torrent.anidb_eid) || 0;
  if (onTarget && plan.eid && eid && fileCount(entry) === 1) return eid === plan.eid;

  // 5. Episode numbers: TMDB numbering for season-marked releases, and the
  //    entry-relative number for releases from the resolved entry.
  var numbers = [];
  if (marked) numbers.push(episode);
  if (onTarget && numbers.indexOf(plan.target.rel) === -1) numbers.push(plan.target.rel);
  return coversEpisode(release, numbers, includeBatches, isBatch);
}

/* ------------------------------------------------------------------ */
/* Stream formatting                                                   */
/* ------------------------------------------------------------------ */

function toNuvioStream(torrent) {
  var title = String(torrent.title || 'AnimeTosho torrent');
  var seeders = Number(torrent.seeders) || 0;
  var quality = qualityFrom(title);
  var details = '📺 ' + title + '\n' +
    '💎 ' + quality + ' | 👤 ' + seeders + ' seeders\n' +
    '💾 ' + humanSize(Number(torrent.total_size) || 0) + ' | AnimeTosho';
  // AnimeTosho's magnet_uri commonly encodes BTIH as Base32. Nuvio validates
  // hashes as 40/64-character hexadecimal strings, so build it from info_hash.
  var magnet = buildHexMagnet(torrent.info_hash) || torrent.torrent_url || '';
  // This core shape mirrors the working Torrentio Nuvio provider. Nuvio's
  // P2P/debrid integration consumes the supplied magnet URL.
  return {
    name: PROVIDER_NAME + ' 👤' + seeders + ' | ' + quality.toUpperCase(),
    title: details,
    size: details,
    description: details,
    url: magnet
  };
}

function buildHexMagnet(infoHash) {
  var hash = String(infoHash || '').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) return '';
  return 'magnet:?xt=urn:btih:' + hash.toLowerCase() + TRACKERS.map(function (tracker) {
    return '&tr=' + encodeURIComponent(tracker);
  }).join('');
}

function qualityFrom(title) {
  var match = String(title).match(/\b(2160|1440|1080|720|576|480)p?\b/i);
  return match ? match[1] + 'p' : 'Unknown';
}

function resolutionValue(title) {
  var match = String(title).match(/\b(2160|1440|1080|720|576|480)p?\b/i);
  return match ? Number(match[1]) : 0;
}

function compareTorrents(left, right) {
  // Requested ordering: highest resolution first, then highest seeder count.
  var resolutionDifference = resolutionValue(right.title) - resolutionValue(left.title);
  if (resolutionDifference) return resolutionDifference;
  return (Number(right.seeders) || 0) - (Number(left.seeders) || 0);
}

function humanSize(bytes) {
  if (!bytes) return 'unknown size';
  var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  var index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, index)).toFixed(index > 1 ? 1 : 0) + ' ' + units[index];
}

function unique(values) {
  return uniqueBy(values.filter(Boolean), function (value) { return String(value).toLowerCase(); });
}

function uniqueBy(values, keyFn) {
  var seen = {};
  return values.filter(function (value) {
    var key = keyFn(value);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function pad2(value) {
  var text = String(value);
  return text.length < 2 ? '0' + text : text;
}

function onSettings() {
  return Promise.resolve([{
    type: 'toggle', key: 'includeBatches', label: 'Include batch torrents for TV episodes', default: true
  }]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
