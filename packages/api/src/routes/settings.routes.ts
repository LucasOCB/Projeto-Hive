import { Router } from 'express';
import { z } from 'zod';
import { Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate';
import { prisma } from '../config/database';
import { resolveOwnerId } from '../helpers/resolveOwnerId';
import { env } from '../config/env';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const ALLOWED_KEYS = [
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_USER_ID',
  'NANO_BANANA_API_KEY',
  'FREEPIK_API_KEY',
  'IMAGE_PROVIDER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'MCP_AUTH_TOKEN',
  'MCP_URL',
  'MCP_TOKEN',
  'YOUTUBE_COOKIES',
];

const NON_SECRET_KEYS = ['MCP_URL', 'MCP_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS', 'INSTAGRAM_USER_ID', 'FACEBOOK_APP_ID', 'YOUTUBE_COOKIES', 'IMAGE_PROVIDER'];

// Check if a key has a value in .env
function getEnvValue(key: string): string | undefined {
  const map: Record<string, string | undefined> = {
    INSTAGRAM_ACCESS_TOKEN: env.INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_USER_ID: env.INSTAGRAM_USER_ID,
    NANO_BANANA_API_KEY: env.NANO_BANANA_API_KEY,
    FREEPIK_API_KEY: env.FREEPIK_API_KEY,
    IMAGE_PROVIDER: env.IMAGE_PROVIDER,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ALLOWED_CHAT_IDS: env.TELEGRAM_ALLOWED_CHAT_IDS,
    FACEBOOK_APP_ID: env.FACEBOOK_APP_ID,
    FACEBOOK_APP_SECRET: env.FACEBOOK_APP_SECRET,
    MCP_AUTH_TOKEN: env.MCP_AUTH_TOKEN,
    MCP_TOKEN: env.INTERNAL_SERVICE_TOKEN,
  };
  return map[key];
}

router.use(authMiddleware);

// GET /api/settings - Get all settings (DB + env fallback)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = await resolveOwnerId(req.userId!);
    const dbSettings = await prisma.setting.findMany({ where: { userId } });
    const dbMap = new Map(dbSettings.map((s) => [s.key, s.value]));

    // Merge: DB takes priority, then env fallback
    const result = ALLOWED_KEYS.map((key) => {
      const dbVal = dbMap.get(key);
      const envVal = getEnvValue(key);
      const value = dbVal || envVal || '';
      const hasValue = value.length > 0;
      const source = dbVal ? 'db' : envVal ? 'env' : 'none';

      let displayValue = '';
      if (hasValue) {
        if (NON_SECRET_KEYS.includes(key)) {
          displayValue = value;
        } else {
          displayValue = value.length > 8 ? '••••••••' + value.slice(-4) : '••••';
        }
      }

      return { key, value: displayValue, hasValue, source };
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// PUT /api/settings - Update a setting
const updateSchema = z.object({
  key: z.string(),
  value: z.string(),
});

router.put('/', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = await resolveOwnerId(req.userId!);
    const { key, value } = req.body;

    if (!ALLOWED_KEYS.includes(key)) {
      res.status(400).json({ success: false, error: 'Key not allowed' });
      return;
    }

    let finalValue = value;

    // Auto-exchange Instagram short-lived token for long-lived token
    if (key === 'INSTAGRAM_ACCESS_TOKEN' && value.startsWith('IGAA')) {
      try {
        // Get Facebook App ID and Secret from DB or env
        const appIdSetting = await prisma.setting.findUnique({ where: { userId_key: { userId, key: 'FACEBOOK_APP_ID' } } });
        const appSecretSetting = await prisma.setting.findUnique({ where: { userId_key: { userId, key: 'FACEBOOK_APP_SECRET' } } });
        const appId = appIdSetting?.value || env.FACEBOOK_APP_ID;
        const appSecret = appSecretSetting?.value || env.FACEBOOK_APP_SECRET;

        if (appId && appSecret) {
          const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${value}`;
          const exchangeRes = await fetch(exchangeUrl);
          const exchangeData = await exchangeRes.json() as any;

          if (exchangeData.access_token) {
            finalValue = exchangeData.access_token;
            console.log(`[Settings] Instagram token exchanged for long-lived token (expires in ${Math.round((exchangeData.expires_in || 0) / 86400)} days)`);
          } else {
            console.warn('[Settings] Token exchange failed:', exchangeData.error?.message || 'Unknown error');
          }
        }
      } catch (err: any) {
        console.warn('[Settings] Token exchange error:', err.message);
      }
    }

    await prisma.setting.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: finalValue },
      update: { value: finalValue },
    });

    const exchanged = finalValue !== value && key === 'INSTAGRAM_ACCESS_TOKEN';
    res.json({ success: true, data: { key, saved: true, exchanged } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// POST /api/settings/youtube-cookies - Upload YouTube cookies.txt
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.post('/youtube-cookies', upload.single('cookies'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    const content = req.file.buffer.toString('utf-8');

    // Save to shared volume (accessible by video-worker)
    const sharedPath = '/app/shared/cookies.txt';
    // Also save to /app/cookies.txt as fallback
    const fallbackPath = '/app/cookies.txt';

    try { fs.mkdirSync('/app/shared', { recursive: true }); } catch { /* ignore */ }
    try { fs.writeFileSync(sharedPath, content); } catch { /* ignore */ }
    try { fs.writeFileSync(fallbackPath, content); } catch { /* ignore */ }

    // Also save in DB for persistence
    const userId = await resolveOwnerId(req.userId!);
    await prisma.setting.upsert({
      where: { userId_key: { userId, key: 'YOUTUBE_COOKIES' } },
      create: { userId, key: 'YOUTUBE_COOKIES', value: 'uploaded' },
      update: { value: 'uploaded' },
    });

    res.json({ success: true, data: { message: 'Cookies salvos com sucesso' } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// DELETE /api/settings/:key - Remove a setting
router.delete('/:key', async (req: AuthRequest, res: Response) => {
  try {
    const userId = await resolveOwnerId(req.userId!);
    const key = req.params.key as string;

    await prisma.setting.deleteMany({ where: { userId, key } });
    res.json({ success: true, data: { key, deleted: true } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

export default router;
