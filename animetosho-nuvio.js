/*
 * AnimeTosho torrent provider for Nuvio.
 *
 * Add `tmdbApiKey` in the provider settings. It may be either a TMDB v3 API
 * key or a TMDB v4 Read Access Token. Nuvio supplies only a TMDB id, whereas
 * AnimeTosho searches by title, so this lookup is required.
 */

var FEED_URL = "https://feed.animetosho.org/json";
var PROVIDER_NAME = "AnimeTosho";
var MAX_RESULTS = 50;

function onSettings() {
  return [
    {
      type: "text",
      key: "tmdbApiKey",
      label: "TMDB API key or Read Access Token",
      isPassword: true,
      required: true,
      placeholder: "TMDB v3 key or v4 token"
    },
    {
      type: "select",
      key: "order",
      label: "Result order",
      defaultValue: "seeders-d",
      options: [
        { label: "Most seeders", value: "seeders-d" },
        { label: "Largest first", value: "size-d" },
        { label: "Newest first", value: "date-d" }
      ]
    },
    {
      type: "toggle",
      key: "includeBatches",
      label: "Include season/batch torrents for episode requests",
      defaultValue: false
    }
  ];
}

function settings() {
  return (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) || {};
}

function fetchJson(url, options) {
  return fetch(url, options).then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status + " from " + url);
    return response.json();
  });
}

function tmdbHeaders(key) {
  // TMDB's v4 Read Access Token is a JWT-like long string; v3 keys are short.
  return key && key.indexOf(".") !== -1 ? { Authorization: "Bearer " + key } : {};
}

function getTitle(tmdbId, mediaType) {
  var key = String(settings().tmdbApiKey || "").trim();
  if (!key) {
    return Promise.reject(new Error("Set a TMDB API key in AnimeTosho's provider settings."));
  }

  var kind = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId);
  if (key.indexOf(".") === -1) url += "?api_key=" + encodeURIComponent(key);

  return fetchJson(url, { headers: tmdbHeaders(key) }).then(function (media) {
    var names = unique([media.name, media.title, media.original_name, media.original_title]);
    if (!names.length) throw new Error("TMDB returned no title for " + tmdbId);
    return names;
  });
}

function searchAnimeTosho(query) {
  var order = settings().order || "seeders-d";
  var url = FEED_URL + "?cat=2020&limit=100&order=" + encodeURIComponent(order) +
    "&q=" + encodeURIComponent(query);
  return fetchJson(url).then(function (items) {
    if (!Array.isArray(items)) throw new Error("AnimeTosho returned an invalid feed.");
    return items;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return getTitle(tmdbId, mediaType).then(function (titles) {
    // Query each localized/original title; AnimeTosho has many releases listed
    // only under their Japanese romanized name.
    return Promise.all(titles.slice(0, 3).map(searchAnimeTosho));
  }).then(function (pages) {
    var all = [];
    pages.forEach(function (page) { all = all.concat(page); });
    return uniqueBy(all, function (torrent) {
      return torrent.info_hash || torrent.magnet_uri || torrent.torrent_url;
    });
  }).then(function (torrents) {
    var filtered = filterForEpisode(torrents, mediaType, season, episode);
    return filtered.slice(0, MAX_RESULTS).map(toStream);
  }).catch(function (error) {
    console.error("[AnimeTosho] " + (error && error.message ? error.message : error));
    return [];
  });
}

function filterForEpisode(torrents, mediaType, season, episode) {
  // Movies have no episode identity to filter against. For TV, keep explicit
  // matching episodes and optionally batches/ranges requested by the user.
  if (mediaType !== "tv" || !episode) return torrents;

  var wantedSeason = Number(season || 1);
  var wantedEpisode = Number(episode);
  var includeBatches = !!settings().includeBatches;

  return torrents.filter(function (torrent) {
    var name = String(torrent.title || "");
    if (matchesEpisode(name, wantedSeason, wantedEpisode)) return true;
    return includeBatches && isBatch(name);
  });
}

function matchesEpisode(title, season, episode) {
  var padded = pad2(episode);
  var seasonPadded = pad2(season);
  var escapedEpisode = escapeRegExp(String(episode));
  var escapedPadded = escapeRegExp(padded);

  // S01E03 / 1x03, E03, EP 3, and standalone [03] release conventions.
  var seasonEpisode = new RegExp("\\bS0?" + season + "[ ._-]*E0?" + episode + "\\b|\\b" + season + "x0?" + episode + "\\b", "i");
  var labelled = new RegExp("\\b(?:E|EP|EPISODE)[ ._-]*0?(?:" + escapedEpisode + ")\\b", "i");
  var bracketed = new RegExp("[\\[\\(]0?(?:" + escapedEpisode + ")[\\]\\)]", "i");
  var dashed = new RegExp("(?:^|\\s)-\\s*0?(?:" + escapedEpisode + ")(?:v\\d+)?\\b", "i");
  var paddedEnd = new RegExp("\\s" + escapedPadded + "(?=\\s*(?:[\\[\\(]|$))", "i");

  // Do not reject a valid E03 title simply because it omitted its season.
  return seasonEpisode.test(title) || labelled.test(title) || bracketed.test(title) || dashed.test(title) || paddedEnd.test(title) ||
    (seasonPadded === "01" && new RegExp("\\b0?" + escapedEpisode + "\\b").test(title) && !isBatch(title));
}

function isBatch(title) {
  return /\b(batch|complete(?:d)?|collection|box\s*set|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season))\b/i.test(title) ||
    /\b(?:S\d{1,2}|Season\s+\d{1,2})\s*(?:-|~|to|through)\s*(?:E?\d{1,3}|S\d{1,2})\b/i.test(title) ||
    /\bE?\d{1,3}\s*(?:-|~|to|through)\s*E?\d{1,3}\b/i.test(title) ||
    /(?:全集|合集|全巻|一挙|완결)/u.test(title);
}

function toStream(torrent) {
  var title = String(torrent.title || "AnimeTosho torrent");
  var quality = getQuality(title);
  var seeders = Number(torrent.seeders) || 0;
  var size = Number(torrent.total_size) || 0;
  var magnet = torrent.magnet_uri || "";

  return {
    name: PROVIDER_NAME,
    title: title + " · " + quality + " · " + seeders + " seeders · " + humanSize(size),
    // Nuvio recognizes magnet URLs for its P2P/debrid pipeline.
    url: magnet || torrent.torrent_url,
    quality: quality,
    size: size,
    // These fields are intentionally included for Nuvio builds that preserve
    // torrent metadata when handing a source to a debrid resolver.
    magnetLink: magnet,
    infoHash: torrent.info_hash || "",
    downloadUrl: torrent.torrent_url || "",
    seeders: seeders,
    leechers: Number(torrent.leechers) || 0,
    isTorrent: true
  };
}

function getQuality(title) {
  var match = String(title).match(/\b(2160|1440|1080|720|576|480)p?\b/i);
  return match ? match[1] + "p" : "Unknown";
}

function humanSize(bytes) {
  if (!bytes) return "unknown size";
  var units = ["B", "KiB", "MiB", "GiB", "TiB"];
  var index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, index)).toFixed(index > 1 ? 1 : 0) + " " + units[index];
}

function unique(values) {
  return uniqueBy(values.filter(Boolean), function (value) { return value.toLowerCase(); });
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

function pad2(value) { return ("0" + value).slice(-2); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

module.exports = { getStreams: getStreams, onSettings: onSettings };
