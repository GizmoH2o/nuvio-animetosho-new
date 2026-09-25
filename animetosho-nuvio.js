'use strict';

/* AnimeTosho for Nuvio. Nuvio passes TMDB ids while AnimeTosho indexes anime
 * by title/AniDB id; AniMap supplies the public mapping, with no TMDB key. */
var PROVIDER_NAME = '🧲 AnimeTosho';
var ANIMAP_API = 'https://animap.id/api/map/tmdb/';
var ANIMETOSHO_API = 'https://feed.animetosho.org/json';
var MAX_RESULTS = 15;

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

function searchAnimeTosho(title, aid) {
  var params = ['cat=2020', 'limit=100', 'order=seeders-d', 'q=' + encodeURIComponent(title)];
  if (aid) params.push('aid=' + encodeURIComponent(String(aid)));
  return fetchJson(ANIMETOSHO_API + '?' + params.join('&')).then(function (items) {
    return Array.isArray(items) ? items : [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return getAnime(tmdbId).then(function (anime) {
    var requests = [];
    anime.titles.forEach(function (title, index) {
      // The canonical title can be restricted by AniDB id. Synonyms cannot:
      // AniMap may combine several entries from a franchise in one response.
      if (index === 0 && anime.aids.length) {
        anime.aids.slice(0, 4).forEach(function (aid) { requests.push(searchAnimeTosho(title, aid)); });
      } else {
        requests.push(searchAnimeTosho(title, null));
      }
    });
    return Promise.all(requests);
  }).then(function (pages) {
    var torrents = [];
    pages.forEach(function (page) { torrents = torrents.concat(page); });
    torrents = uniqueBy(torrents, function (torrent) {
      return torrent.info_hash || torrent.magnet_uri || torrent.torrent_url;
    });
    if (mediaType === 'tv' || mediaType === 'series') {
      torrents = filterEpisodes(torrents, Number(season || 1), Number(episode || 1));
    }
    return torrents.sort(function (left, right) {
      return (Number(right.seeders) || 0) - (Number(left.seeders) || 0);
    }).slice(0, MAX_RESULTS).map(toNuvioStream);
  }).catch(function (error) {
    console.error('[AnimeTosho] ' + (error && error.message ? error.message : String(error)));
    return [];
  });
}

function filterEpisodes(torrents, season, episode) {
  var includeBatches = !!getRuntimeSettings().includeBatches;
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
  return seasonEpisode.test(title) || labelled.test(title) || bracketed.test(title) || dashed.test(title) || padded.test(title);
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
  // This core shape mirrors the working Torrentio Nuvio provider. Nuvio's
  // P2P/debrid integration consumes the supplied magnet URL.
  return {
    name: PROVIDER_NAME + ' 👤' + seeders + ' | ' + quality.toUpperCase(),
    title: details,
    size: details,
    description: details,
    url: torrent.magnet_uri || torrent.torrent_url || ''
  };
}

function qualityFrom(title) {
  var match = String(title).match(/\b(2160|1440|1080|720|576|480)p?\b/i);
  return match ? match[1] + 'p' : 'Unknown';
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
    type: 'toggle', key: 'includeBatches', label: 'Include batch torrents for TV episodes', default: false
  }]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
