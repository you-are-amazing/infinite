// Node 20+, zero dependencies. Fetches positive-news RSS feeds, tags them (Gemini if key set), writes static/data/news.json
const fs = require('fs');
const FEEDS = [
  ['Good News Network', 'https://www.goodnewsnetwork.org/feed/'],
  ['Positive News', 'https://www.positive.news/feed/'],
  ['r/UpliftingNews', 'https://www.reddit.com/r/UpliftingNews/.rss'],
  ['Google News', 'https://news.google.com/rss/search?q=inspiring+success+story+students+OR+engineers+OR+athletes&hl=en-IN&gl=IN&ceid=IN:en']
];
const STOP = new Set('the a an and or of to in on for with from by is are was were be as at it this that new after over into how why who has have his her their its you your not but out up more says say man woman'.split(' '));
const clean = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&#8217;/g, "'").replace(/&quot;/g, '"').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? clean(m[1]) : ''; };

async function pull([source, url]) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 deserve-inspire-bot' } });
    const xml = await r.text();
    const blocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) || [];
    return blocks.slice(0, 15).map(b => ({
      title: tag(b, 'title'),
      link: tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '',
      summary: clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 220),
      published: tag(b, 'pubDate') || tag(b, 'updated') || '',
      source
    })).filter(i => i.title && i.link);
  } catch (e) { console.error('feed failed', source, e.message); return []; }
}

const localTopics = t => [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)))].slice(0, 4);

async function aiTag(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return items.map(i => ({ ...i, topics: localTopics(i.title + ' ' + i.summary) }));
  const prompt = `You curate a motivational feed for students and early-career engineers. For each headline return JSON array items {"i":index,"positive":boolean,"topics":[max 4 lowercase single-word tags such as coding, exams, fitness, career, money, health, startup, learning, sports, discipline],"why":"max 14 words: why this is motivating"}. positive=false for negative, tragic, political or clickbait items.\n` +
    items.map((x, n) => `${n}. ${x.title}`).join('\n');
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } })
    });
    const j = await r.json();
    const out = JSON.parse(j.candidates[0].content.parts[0].text);
    const byIdx = Object.fromEntries(out.map(o => [o.i, o]));
    return items.map((x, n) => byIdx[n] && byIdx[n].positive ? { ...x, topics: byIdx[n].topics, why: byIdx[n].why } : null).filter(Boolean);
  } catch (e) {
    console.error('Gemini failed, using local tags:', e.message);
    return items.map(i => ({ ...i, topics: localTopics(i.title + ' ' + i.summary) }));
  }
}

(async () => {
  const all = (await Promise.all(FEEDS.map(pull))).flat();
  const seen = new Set();
  const uniq = all.filter(i => !seen.has(i.link) && seen.add(i.link)).slice(0, 50);
  const tagged = await aiTag(uniq);
  fs.mkdirSync('static/data', { recursive: true });
  fs.writeFileSync('static/data/news.json', JSON.stringify({ updated: new Date().toISOString(), items: tagged }, null, 1));
  console.log('wrote', tagged.length, 'items');
})();
