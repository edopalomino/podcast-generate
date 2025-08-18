import 'dotenv/config';
import RSSParser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { GoogleGenAI } from '@google/genai';
import wav from 'wav';
import cloudinaryLib from 'cloudinary';
import { createRestAPIClient } from 'masto';
import { randomUUID } from 'crypto';

const RSS_FEEDS = [
  // IA
  'https://ai.googleblog.com/feeds/posts/default?alt=rss',
  'https://openai.com/blog/rss', 
  // Web/dev
  'https://developer.chrome.com/feeds/blog.xml',
  'https://nodejs.org/en/feed/blog.xml',
  'https://webkit.org/feed/',
  'https://www.typescriptlang.org/feed.xml',
  'https://news.mit.edu/rss/topic/artificial-intelligence2',
];

const parser = new RSSParser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Cloudinary
const cloudinary = cloudinaryLib.v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Mastodon
const masto = createRestAPIClient({
  url: process.env.MASTODON_URL,
  accessToken: process.env.MASTODON_TOKEN,
});

// ---- Utils
const hoursAgo = (h) => Date.now() - h * 3600_000;
const uniqueby = (arr, key) => [...new Map(arr.map(x => [key(x), x])).values()];

async function extractArticleText(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article?.textContent?.trim() || '';
  } catch {
    return '';
  }
}

async function fetchRecentItems() {
  const cutoff = hoursAgo(48);
  const items = [];
  for (const feed of RSS_FEEDS) {
    try {
      const r = await parser.parseURL(feed);
      for (const it of r.items ?? []) {
        const pub = it.isoDate ? new Date(it.isoDate).getTime() : Date.now();
        if (pub >= cutoff) items.push({ title: it.title, link: it.link, summary: it.contentSnippet });
      }
    } catch { /* ignore feed errors */ }
  }
  // Dedupe por título o URL
  return uniqueby(items, x => x.link || x.title).slice(0, 6);
}

async function buildScript(stories) {
  // Enriquecer con texto del artículo si hace falta
  const enriched = [];
  for (const s of stories) {
    const body = s.summary && s.summary.length > 200 ? s.summary : await extractArticleText(s.link);
    enriched.push({ ...s, body: (body || '').slice(0, 4000) });
  }

  const prompt = `
Eres guionista de "Super Happy Dev", un micro-podcast de noticias para devs en LatAm.
Escribe una charla natural entre dos amigos (Happy y Dev). Tono: ameno, geeky, claro, sin muletillas artificiales.
Reglas:
FORMATO DE SALIDA (OBLIGATORIO):
- Solo líneas que comiencen con “Speaker 1:” o “Speaker 2:”.
- Primera línea exacta:
Tono ameno, geeky/friki y claro, como una charla entre dos amigos.
Speaker 1: Hola, bienvenidos al podcast de Super Happy Dev.
- Después de esa línea, establece el tono únicamente con el diálogo. No uses acotaciones, efectos, notas, encabezados, emojis, guiones de escena ni texto fuera del diálogo.
- Última línea: despedida clara que invite a seguir el podcast (por ejemplo: “gracias por escuchar, hasta la siguiente semana”).

Noticias (título + resumen):
${enriched.map((s,i)=>`[${i+1}] ${s.title}\n${s.body || ''}`).join('\n\n')}
`;

  const resp = await ai.models.generateContent({
    model: 'gemini-2.5-pro',  // calidad para escritura
    contents: [{ role: 'user', parts: [{ text: prompt }]}],
  });
    return resp.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function ttsMultiSpeaker(scriptText, outFile='episode.wav') {
  // El modelo TTS entrega PCM 24k; lo guardamos a WAV.
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ parts: [{ text: `TTS esta conversación entre Happy y Dev:\n${scriptText}` }]}],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: 'Happy', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            { speaker: 'Dev',   voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          ],
        },
      },
    },
  });

  const b64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  const pcm = Buffer.from(b64, 'base64');

  await new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(outFile, { channels: 1, sampleRate: 24000, bitDepth: 16 });
    writer.on('finish', resolve);
    writer.on('error', reject);
    writer.write(pcm);
    writer.end();
  });

  return outFile;
}

async function uploadToCloudinary(filepath, publicId) {
  // Audio se sube como resource_type "video"
  const res = await cloudinary.uploader.upload(filepath, {
    resource_type: 'video',
    folder: 'super-happy-dev',
    public_id: publicId,
    overwrite: true,
  });
  return res.secure_url;
}

async function postToMastodon(text, url) {
  const status = await masto.v1.statuses.create({
    status: `${text}\n\nEscúchalo aquí: ${url}`,
    visibility: 'public',
  });
  return status.url;
}

async function main() {
  console.log('Obteniendo noticias recientes...');
  const items = await fetchRecentItems();
  if (!items.length) throw new Error('No hay noticias recientes en los feeds configurados.');
  console.log('Generando guion del episodio...');
  const script = await buildScript(items);
  console.log('Generando audio TTS...');
  const uuid = randomUUID();
  const wavPath = await ttsMultiSpeaker(script, `episode-${uuid}.wav`);
  const dateTag = new Date().toISOString().slice(0,10);
  console.log('Subiendo episodio a Cloudinary...');
  const cdnUrl = await uploadToCloudinary(wavPath, `shd-${dateTag}-${uuid}`);
  console.log('Publicando en Mastodon...');
  const tootUrl = await postToMastodon('Nuevo episodio de Super Happy Dev 🎧', cdnUrl);
  console.log('Publicado en:', tootUrl);
  process.exit(0); // Finaliza el proceso exitosamente
}

main().catch(err => { console.error(err); process.exit(1); });
