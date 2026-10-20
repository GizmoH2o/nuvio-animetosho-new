'use strict';
/* AnimeTosho for Nuvio. Nuvio passes TMDB ids while AnimeTosho indexes anime
by title/AniDB id; AniMap supplies the public mapping, with no TMDB key.
Season/episode correctness notes:
One TMDB show usually maps to several AniDB entries (one per season/cour),
so an AniDB-id search returns releases from every season. Titles must
therefore be parsed and checked against the requested season AND episode.
Releases without a season marker ("Show - 03") are assigned a season from
the other releases that share their AniDB id (see buildContext).
When in doubt a release is rejected: no result beats a wrong result.
*/
var PROVIDER_NAME = '🧲 AnimeTosho';
var ANIMAP_API = 'https://animap.id/api/map/tmdb/';
var ANIMETOSHO_API = 'https://feed.animetosho.org/json';
var MAX_RESULTS = 50;
var MAX_AIDS = 6;
var PAGES_PER_QUERY = 3;
var TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce'
];

/* ------------------------------------------------------------------ /
/ Networking                                                          /
/ ------------------------------------------------------------------ */
function fetchJson(url, options) {
    return fetch(url, options || {}).then(function (response) { 
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json(); 
    });
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

function getAnime(tmdbId) {
    console.log('[AnimeTosho] Fetching AniMap for TMDB:', tmdbId);
    return fetchJson(ANIMAP_API + encodeURIComponent(String(tmdbId))).then(function (anime) {
        if (!anime || !anime.title) throw new Error('No AniMap entry for TMDB ' + tmdbId);
        console.log('[AnimeTosho] AniMap found:', anime.title, '| AIDs:', anime.anidb_id);
        return {
            titles: unique([anime.title].concat(toArray(anime.synonyms))).slice(0, 4),
            aids: unique(toArray(anime.anidb_id).map(Number).filter(function (aid) { return aid > 0; }))
        };
    }).catch(function(err) {
        console.error('[AnimeTosho] AniMap API failed:', err.message);
        // Fallback: If animap.id is down, you might need to swap ANIMAP_API to a working alternative
        throw err; 
    });
}

function searchAnimeTosho(title, aid, page) {
    // FIX: Removed invalid 'cat=2020' parameter. 
    // FIX: Only append 'q=' if title is actually provided, otherwise AnimeTosho returns 0 results.
    var params = ['limit=100', 'order=seeders-d', 'page=' + (page || 1)];
    if (title) params.push('q=' + encodeURIComponent(title));
    if (aid) params.push('aid=' + encodeURIComponent(String(aid)));
    
    return fetchJson(ANIMETOSHO_API + '?' + params.join('&')).then(function (items) {
        return Array.isArray(items) ? items : [];
    }).catch(function (err) {
        console.error('[AnimeTosho] AnimeTosho API error:', err);
        return [];
    });
}

function fetchTorrentsPaginated(title, aid) {
    var pages = [];
    for (var page = 1; page <= PAGES_PER_QUERY; page++) pages.push(searchAnimeTosho(title, aid, page));
    return Promise.all(pages).then(flattenPages);
}

function searchByIds(anime) {
    return Promise.all(anime.aids.slice(0, MAX_AIDS).map(function (aid) {
        return fetchTorrentsPaginated('', aid);
    })).then(flattenPages);
}

function searchByTitles(anime) {
    return Promise.all(anime.titles.map(function (title) {
        return fetchTorrentsPaginated(title, null);
    })).then(flattenPages);
}

function flattenPages(pages) {
    var torrents = [];
    pages.forEach(function (page) { torrents = torrents.concat(page); });
    return torrents;
}

/* ------------------------------------------------------------------ /
/ Entry point                                                         /
/ ------------------------------------------------------------------ */
function toInt(value, fallback) {
    var number = parseInt(value, 10);
    return isFinite(number) && number >= 0 ? number : fallback;
}

function getStreams(tmdbId, mediaType, season, episode) {
    var request = {
        isSeries: mediaType === 'tv' || mediaType === 'series',
        season: toInt(season, 1),
        episode: toInt(episode, 1)
    };
    console.log('[AnimeTosho] getStreams called for:', tmdbId, 'S' + request.season + 'E' + request.episode);

    return getAnime(tmdbId).then(function (anime) {
        return searchByIds(anime).then(function (torrents) {
            console.log('[AnimeTosho] Found', torrents.length, 'torrents via ID search');
            if (torrents.length || !anime.titles.length) return torrents;
            return searchByTitles(anime);
        });
    }).then(function (torrents) {
        console.log('[AnimeTosho] Total raw torrents before filtering:', torrents.length);
        return selectTorrents(torrents, request).slice(0, MAX_RESULTS).map(toNuvioStream);
    }).then(function(streams) {
        console.log('[AnimeTosho] Final streams returned:', streams.length);
        return streams;
    }).catch(function (error) {
        console.error('[AnimeTosho] Fatal error:', error.message || error);
        return [];
    });
}

function selectTorrents(torrents, request) {
    var deduped = uniqueBy(torrents, function (torrent) {
        return torrent.info_hash || torrent.magnet_uri || torrent.torrent_url;
    });
    var entries = deduped.map(function (torrent) {
        return { torrent: torrent, release: parseRelease(torrent.title), aid: Number(torrent.anidb_aid) || 0 };
    });
    
    if (request.isSeries) {
        var includeBatches = getRuntimeSettings().includeBatches !== false;
        var context = buildContext(entries);
        entries = entries.filter(function (entry) {
            return matchesRequest(entry, request, context, includeBatches);
        });
    }
    
    return entries
        .map(function (entry) { return entry.torrent; })
        .filter(function (torrent) { return Number(torrent.seeders) > 0; })
        .sort(compareTorrents);
}

/* ------------------------------------------------------------------ /
/ Release-title parsing                                               /
/ ------------------------------------------------------------------ */
// FIX: Completely overhauled regexes. The original file had broken character 
// classes (e.g. `[\s])_.,]`) and required literal spaces that broke standard formats like `S01E01`.
var RE = {
    seasonEpisode: /\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:v\d+)?(?:[ ._]?(?:-|~|to)[ ._]?E?(\d{1,4})|[ ._-]?E(\d{1,4}))?/gi,
    nxm: /\b(\d{1,2})x(\d{1,3})(?:v\d+)?(?:[ ._]?(?:-|~)[ ._]?(\d{1,3}))?(?!\d)/gi,
    seasonRangeS: /\bS(\d{1,2})[ ._]?(?:-|~|to)[ ._]?S(\d{1,2})\b/gi,
    seasonRangeWord: /\bSeasons?[ ._](\d{1,2})[ ._](?:-|~|to|&|and)[ ._](\d{1,2})\b/gi,
    season: /\bS(\d{1,2})\b/gi,
    seasonWord: /\bSeason[ ._](\d{1,2})\b/gi,
    seasonOrdinal: /\b(\d{1,2})(?:st|nd|rd|th)[ ._]Season\b/gi,
    rangeBracketed: /[[\(]\s*(?:E|EP|Episodes?)?[ ._]?(\d{1,4})(?:v\d+)?\s*(?:-|~|to|through)\s*(?:E|EP)?[ ._]?(\d{1,4})(?:v\d+)?\s*(?:END|FIN)?\s*[\]\)]/gi,
    rangeTight: /(?:^|[\s\[\(_\.])(?:E|EP)?(\d{1,4})(?:v\d+)?(?:-|~)(?:E|EP)?(\d{1,4})(?:v\d+)?(?=$|[\s\[\]\(\)\._,])/gi,
    rangeWord: /(?:^|[\s\[\(_\.])(?:E|EP)?(\d{1,4})(?:v\d+)?[ ._](?:~|to|through)[ ._](?:E|EP)?(\d{1,4})(?:v\d+)?(?=$|[\s\[\]\(\)\._,])/gi,
    rangeLabelled: /\b(?:EPS?|Episodes?)[ ._](\d{1,4})[ ._](?:-|~|to|through)[ ._](\d{1,4})\b/gi,
    rangeSpaced: /(?:^|[\s\[\(_\.])(\d{1,4})[ ._]+-[ ._]+(\d{1,4})(?=$|[\s\[\]\(\)\._,])/gi,
    labelled: /\b(?:EP|E|Episode)[ ._](\d{1,4})(?:v\d+)?(?!\d)/gi,
    dashed: /(?:^|[\s\[\(_\.])-?[ ._](\d{1,4})(?:v\d+)?(?=$|[\s\[\]\(\)\._,])/gi,
    bracketed: /[[\(]\s*(\d{1,4})(?:v\d+)?\s*(?:END|FIN)?\s*[\]\)]/gi,
    padded: /\s(\d{2,4})(?:v\d+)?(?=\s*(?:[\[\(]|$))/gi,
    batch: /\b(?:batch|complete(?:d)?|collection|box\s*set|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season))\b|全集|合集|全巻|一挙|완결/i,
    extra: /\b(?:OVAs?|OADs?|NCOP|NCED|Creditless|Trailer)\b/i,
    special: /\b(?:OVAs?|OADs?|ONAs?|Specials?|SP)\b/i
};

function stripNoise(title) {
    return String(title || '')
        .replace(/\b[0-9a-f]{8}\b/gi, ' ') // CRC32 hashes
        .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ') // Resolutions like 1920x1080
        .replace(/\b(?:2160|1440|1080|720|576|480)[pi]\b/gi, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ') // Years
        .replace(/\b[xh][ .]?26[45]\b/gi, ' ') // Codecs
        .replace(/\b\d{1,2}[ -]?bits?\b/gi, ' ')
        .replace(/\b(?:aac|ac3|eac3|flac|dts|opus|ddp?|truehd)[ .]?\d(?:\.\d)?\b/gi, ' ')
        .replace(/\b[257]\.[01]\b/g, ' ') // Audio channels
        .replace(/\s+/g, ' ');
}

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
        explicit: [],   
        seasons: [],    
        episodes: [],   
        ranges: [],     
        batch: RE.batch.test(title),
        extra: RE.extra.test(title),
        special: RE.special.test(title)
    };

    function addExplicit(match) {
        var from = Number(match[2]);
        var to = Number(match[3] || match[4] || match[2]);
        release.explicit.push({ season: Number(match[1]), from: Math.min(from, to), to: Math.max(from, to) });
    }
    function addSeasonRange(match) {
        var from = Number(match[1]);
        var to = Number(match[2]);
        if (to < from || to - from > 50) return;
        for (var s = from; s <= to; s++) addSeason(s);
    }
    function addSeason(value) {
        var number = Number(value);
        if (release.seasons.indexOf(number) === -1) release.seasons.push(number);
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

    if (release.batch) text = consume(text, RE.rangeSpaced, addRange);

    text = consume(text, RE.labelled, addEpisode);
    text = consume(text, RE.dashed, addEpisode);
    text = consume(text, RE.bracketed, addEpisode);

    if (!release.explicit.length && !release.ranges.length && !release.episodes.length) {
        consume(text, RE.padded, addEpisode);
    }

    if (release.seasons.length && !release.explicit.length && !release.ranges.length && !release.episodes.length) {
        release.batch = true;
    }

    return release;
}

/* ------------------------------------------------------------------ /
/ Season / episode matching                                           /
/ ------------------------------------------------------------------ */
function singleSeason(release) {
    if (release.extra) return null;
    var seasons = [];
    release.explicit.forEach(function (item) {
        if (seasons.indexOf(item.season) === -1) seasons.push(item.season);
    });
    if (!release.explicit.length) seasons = release.seasons;
    return seasons.length === 1 ? seasons[0] : null;
}

function buildContext(entries) {
    var votes = {};
    var aids = [];
    entries.forEach(function (entry) {
        if (!entry.aid) return;
        if (aids.indexOf(entry.aid) === -1) aids.push(entry.aid);
        var season = singleSeason(entry.release);
        if (season === null || season === 0) return;
        votes[entry.aid] = votes[entry.aid] || {};
        votes[entry.aid][season] = (votes[entry.aid][season] || 0) + 1;
    });

    var aidSeasons = {};
    var unvoted = [];
    var hasFirstSeason = false;

    aids.forEach(function (aid) {
        var counts = votes[aid];
        if (!counts) { unvoted.push(aid); return; }
        var best = null;
        Object.keys(counts).forEach(function (key) {
            var season = Number(key);
            if (best === null || counts[season] > counts[best] || (counts[season] === counts[best] && season < best)) best = season;
        });
        aidSeasons[aid] = best;
        if (best === 1) hasFirstSeason = true;
    });

    return {
        aidSeasons: aidSeasons,
        baseAid: hasFirstSeason || !unvoted.length ? null : Math.min.apply(null, unvoted)
    };
}

function assumedSeason(aid, context) {
    if (!aid) return 1;
    if (Object.prototype.hasOwnProperty.call(context.aidSeasons, aid)) return context.aidSeasons[aid];
    return aid === context.baseAid ? 1 : null;
}

function matchesRequest(entry, request, context, includeBatches) {
    var release = entry.release;
    var season = request.season;
    var episode = request.episode;
    var i;

    if (release.explicit.length) {
        for (i = 0; i < release.explicit.length; i++) {
            var item = release.explicit[i];
            if (item.season !== season || episode < item.from || episode > item.to) continue;
            if (item.from === item.to || includeBatches) return true;
        }
        return false;
    }

    if (season === 0) {
        if (release.seasons.indexOf(0) === -1 && !release.special) return false;
    } else {
        if (release.extra) return false;
        var seasons = release.seasons;
        if (!seasons.length) {
            var assumed = assumedSeason(entry.aid, context);
            seasons = assumed === null ? [] : [assumed];
        }
        if (seasons.indexOf(season) === -1) return false;
    }

    if (release.episodes.indexOf(episode) !== -1) return true;
    if (!includeBatches) return false;

    for (i = 0; i < release.ranges.length; i++) {
        if (episode >= release.ranges[i].from && episode <= release.ranges[i].to) return true;
    }

    if (release.ranges.length || release.episodes.length) return false;
    return release.batch;
}

/* ------------------------------------------------------------------ /
/ Stream formatting                                                   /
/ ------------------------------------------------------------------ */
function toNuvioStream(torrent) {
    var title = String(torrent.title || 'AnimeTosho torrent');
    var seeders = Number(torrent.seeders) || 0;
    var quality = qualityFrom(title);
    var details = '📺 ' + title + '\n' +
        '💎 ' + quality + ' | 👤 ' + seeders + ' seeders\n' +
        '💾 ' + humanSize(Number(torrent.total_size) || 0) + ' | AnimeTosho';

    var magnet = buildHexMagnet(torrent.info_hash) || torrent.torrent_url || '';

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

function onSettings() {
    return Promise.resolve([{
        type: 'toggle', key: 'includeBatches', label: 'Include batch torrents for TV episodes', default: true
    }]);
}

module.exports = { getStreams: getStreams, onSettings: onSettings };
