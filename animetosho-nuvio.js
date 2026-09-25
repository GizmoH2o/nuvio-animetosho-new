'use strict';

/* AnimeTosho for Nuvio. Nuvio passes TMDB ids while AnimeTosho indexes anime
 * by title/AniDB id; AniMap supplies the public mapping, with no TMDB key. */
var PROVIDER_NAME = '🧲 AnimeTosho';
var ANIMAP_API = 'https://animap.id/api/map/tmdb/';
var ANIMETOSHO_API = 'https://feed.animetosho.org/json';
var MAX_RESULTS = 50;
var TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce'
];

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

function getAnime(tmdbId) {
  return fetchJson(ANIMAP_API + encodeURIComponent(String(tmdbId))).then(function (anime) {
    if (!anime || !anime.title) throw new Error('No AniMap entry for TMDB ' + tmdbId);
    return {
      titles: unique([anime.title].concat(anime.synonyms || [])).slice(0, 4),
      aids: Array.isArray(anime.anidb_id) ? anime.anidb_id : []
    };
  });
}

function searchAnimeTosho(title, aid, page) {
  var params = ['cat=2020', 'limit=100', 'order=seeders-d', 'page=' + (page || 1), 'q=' + encodeURIComponent(title)];
  if (aid) params.push('aid=' + encodeURIComponent(String(aid)));
  return fetchJson(ANIMETOSHO_API + '?' + params.join('&')).then(function (items) {
    return Array.isArray(items) ? items : [];
  });
}

function fetchTorrentsPaginated(title, aid) {
  // AnimeTosho's own provider walks three pages. This matters for older shows
  // and releases which were sorted below the current high-seeder results.
  return Promise.all([1, 2, 3].map(function (page) {
    return searchAnimeTosho(title, aid, page);
  })).then(function (pages) {
    var torrents = [];
    pages.forEach(function (page) { torrents = torrents.concat(page); });
    return torrents;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return getAnime(tmdbId).then(function (anime) {
    var idRequests = anime.aids.slice(0, 4).map(function (aid) {
      // The AID is exact and gives us all releases, including ones whose
      // release title does not contain AniMap's canonical title.
      return fetchTorrentsPaginated('', aid);
    });
    // Follow the original provider's sequence: search by ID first, and only
    // issue broader title searches if the ID lookup did not produce anything.
    return Promise.all(idRequests).then(function (pages) {
      if (flattenPages(pages).length || !anime.titles.length) return pages;
      return Promise.all(anime.titles.map(function (title) {
        return fetchTorrentsPaginated(title, null);
      }));
    });
  }).then(function (pages) {
    var torrents = flattenPages(pages);
    torrents = uniqueBy(torrents, function (torrent) {
      return torrent.info_hash || torrent.magnet_uri || torrent.torrent_url;
    });
    if (mediaType === 'tv' || mediaType === 'series') {
      torrents = filterEpisodes(torrents, Number(season || 1), Number(episode || 1));
    }
    return torrents.sort(compareTorrents).slice(0, MAX_RESULTS).map(toNuvioStream);
  }).catch(function (error) {
    console.error('[AnimeTosho] ' + (error && error.message ? error.message : String(error)));
    return [];
  });
}

function flattenPages(pages) {
  var torrents = [];
  pages.forEach(function (page) { torrents = torrents.concat(page); });
  return torrents;
}

function filterEpisodes(torrents, season, episode) {
  var includeBatches = getRuntimeSettings().includeBatches !== false;
  return torrents.filter(function (torrent) {
    var title = String(torrent.title || '');
    return matchesEpisode(title, season, episode) || (includeBatches && isBatch(title));
  });
}

function matchesEpisode(title, season, episode) {
  if (!episode) return true;
  var ep = String(episode);
  var ep2 = pad2(episode);
  var seasonEpisode = new RegExp('\\bS0?' + season + '[ ._-]*E0?' + ep + '\\b|\\b' + season + 'x0?' + ep + '\\b', 'i');
  var labelled = new RegExp('\\b(?:E|EP|EPISODE)[ ._-]*0?' + ep + '\\b', 'i');
  var bracketed = new RegExp('[\\[\\(]0?' + ep + '(?:v\\d+)?[\\]\\)]', 'i');
  var dashed = new RegExp('(?:^|\\s)-\\s*0?' + ep + '(?:v\\d+)?\\b', 'i');
  var padded = new RegExp('\\s' + ep2 + '(?=\\s*(?:[\\[\\(]|$))', 'i');
  return seasonEpisode.test(title) || labelled.test(title) || bracketed.test(title) || dashed.test(title) || padded.test(title) ||
    episodeIsInRange(title, episode);
}

function episodeIsInRange(title, episode) {
  var range = /(?:\bS\d{1,2}[ ._-]*)?E?(\d{1,3})(?:v\d+)?\s*(?:-|~|\.\.|to|through)\s*(?:S\d{1,2}[ ._-]*E?)?(\d{1,3})(?:v\d+)?\b/gi;
  var match;
  while ((match = range.exec(title)) !== null) {
    var from = Number(match[1]);
    var to = Number(match[2]);
    if (to > from && episode >= from && episode <= to) return true;
  }
  return false;
}

function isBatch(title) {
  return /\b(batch|complete(?:d)?|collection|box\s*set|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season))\b/i.test(title) ||
    /\bE?\d{1,3}\s*(?:-|~|to|through)\s*E?\d{1,3}\b/i.test(title) ||
    /(?:全集|合集|全巻|一挙|완결)/u.test(title);
}

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
  // Requested ordering: highest resolution first, then most seeders.
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

function pad2(value) { return ('0' + value).slice(-2); }

function onSettings() {
  return Promise.resolve([{
    type: 'toggle', key: 'includeBatches', label: 'Include batch torrents for TV episodes', default: true
  }]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
