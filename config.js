// config.js
export const RSS_FEEDS = [
  'https://ai.googleblog.com/feeds/posts/default?alt=rss',
  'https://openai.com/blog/rss',
  'https://developer.chrome.com/feeds/blog.xml',
  'https://nodejs.org/en/feed/blog.xml',
  'https://webkit.org/feed/',
  'https://www.typescriptlang.org/feed.xml',
  'https://news.mit.edu/rss/topic/artificial-intelligence2',
];

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const CLOUDINARY_CONFIG = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};

export const MASTODON_CONFIG = {
  url: process.env.MASTODON_URL,
  accessToken: process.env.MASTODON_TOKEN,
};
