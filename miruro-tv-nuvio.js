const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const Queue = require('p-queue').default;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Initialize Stealth to bypass bot detection
puppeteer.use(new StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`; // Change to your public IP/Domain

// Cache for 1 hour (3600 seconds) to prevent redundant scraping
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// Limit to 2 concurrent headless browsers to prevent RAM exhaustion
const scraperQueue = new Queue({ concurrency: 2, timeout: 60000 }); 

let browser;

// --- INITIALIZATION ---
async function initBrowser() {
    console.log('[Init] Launching headless browser...');
    browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', // Crucial for Docker/Linux
            '--disable-gpu',
            '--single-process'
        ]
    });
    console.log('[Init] Browser ready.');
}

// --- CORE SCRAPER LOGIC ---
async function scrapeEpisode(animeSlug, episode) {
    const cacheKey = `${animeSlug}_${episode}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[Cache] Hit for ${cacheKey}`);
        return cached;
    }

    // Use incognito context to prevent memory leaks from cookies/localStorage
    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();

    // Block heavy resources to speed up scraping and save RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    let m3u8Url = null;
    let subtitles = [];

    // Network Interception
    page.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';

        // Catch HLS Video Stream
        if ((url.includes('.m3u8') || contentType.includes('mpegurl')) && !m3u8Url) {
            m3u8Url = url;
        }

        // Catch Subtitles
        if (url.includes('.vtt') || url.includes('.srt') || contentType.includes('text/vtt')) {
            let lang = 'Unknown';
            const match = url.match(/\/([a-zA-Z]{2,3})\.(vtt|srt)/i) || 
                          url.match(/(English|Spanish|French|Portuguese|German|Italian|Russian|Arabic)\.vtt/i);
            if (match) lang = match[1];
            
            // Prevent duplicate subtitles
            if (!subtitles.find(s => s.url === url)) {
                subtitles.push({ url: url, lang: lang });
            }
        }
    });

    try {
        console.log(`[Scraper] Navigating to ${animeSlug} EP ${episode}`);
        await page.goto(`https://miruro.tv/watch/${animeSlug}/${episode}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        // Wait for the player iframe or video tag to appear
        await page.waitForSelector('iframe, video', { timeout: 15000 }).catch(() => {});
        
        // Give the site's JavaScript time to decrypt the video ID and request the .m3u8
        await new Promise(r => setTimeout(r, 6000)); 

    } catch (err) {
        console.error(`[Scraper] Error: ${err.message}`);
    } finally {
        await page.close();
        await context.close(); // Crucial: frees up memory
    }

    if (!m3u8Url) throw new Error('Failed to extract video stream. Site structure may have changed.');

    const result = { videoUrl: m3u8Url, subtitles: subtitles };
    cache.set(cacheKey, result);
    return result;
}

// --- API ENDPOINTS ---

// 1. The main endpoint your TV plugin will call
app.get('/api/stream/:slug/:ep', async (req, res) => {
    const { slug, ep } = req.params;
    try {
        // Add to queue to prevent server overload
        const data = await scraperQueue.add(() => scrapeEpisode(slug, ep));
        
        // Rewrite URLs to route through our CORS proxy
        const proxiedVideo = `${SERVER_URL}/proxy/m3u8?url=${encodeURIComponent(data.videoUrl)}`;
        const proxiedSubs = data.subtitles.map(s => ({
            lang: s.lang,
            url: `${SERVER_URL}/proxy/subtitle?url=${encodeURIComponent(s.url)}`
        }));

        res.json({
            success: true,
            stream: {
                url: proxiedVideo,
                subtitles: proxiedSubs
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Proxy for .m3u8 (Rewrites .ts segment URLs to point to our segment proxy)
app.get('/proxy/m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    try {
        const response = await axios.get(targetUrl, { 
            responseType: 'text', 
            headers: { 'Referer': 'https://miruro.tv/', 'User-Agent': 'Mozilla/5.0' } 
        });
        
        const baseUrl = new URL(targetUrl);
        const lines = response.data.split('\n');
        
        // Rewrite URIs to point to our /proxy/segment endpoint
        const rewrittenLines = lines.map(line => {
            if (line.startsWith('#') || line.trim() === '') return line;
            
            let absoluteUrl = line;
            if (!line.startsWith('http')) {
                absoluteUrl = new URL(line, baseUrl).href;
            }
            return `${SERVER_URL}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}`;
        });

        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewrittenLines.join('\n'));
    } catch (err) {
        res.status(500).send('M3U8 Proxy Error');
    }
});

// 3. Proxy for .ts video segments
app.get('/proxy/segment', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    try {
        const response = await axios.get(targetUrl, { 
            responseType: 'stream', 
            headers: { 'Referer': 'https://miruro.tv/', 'User-Agent': 'Mozilla/5.0' } 
        });
        res.set('Content-Type', 'video/mp2t');
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Segment Proxy Error');
    }
});

// 4. Proxy for Subtitles
app.get('/proxy/subtitle', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    try {
        const response = await axios.get(targetUrl, { responseType: 'stream' });
        res.set('Content-Type', 'text/vtt');
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Subtitle Proxy Error');
    }
});

// --- START SERVER ---
(async () => {
    await initBrowser();
    app.listen(PORT, () => {
        console.log(`[Server] Nuvio TV Miruro Backend running on port ${PORT}`);
    });
})();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[Server] Shutting down...');
    if (browser) await browser.close();
    process.exit(0);
});