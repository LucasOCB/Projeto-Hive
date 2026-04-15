import { randomUUID } from 'crypto';
import { minioClient } from '../config/minio';
import { env } from '../config/env';
import { getSetting } from '../helpers/getSetting';

interface GenerateImageParams {
  prompt: string;
  style?: string;
  aspectRatio?: '1:1' | '9:16' | '4:5';
}

interface GenerateImageResult {
  imageUrl: string;
  minioKey: string;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function enrichPrompt(prompt: string, style?: string): string {
  const base = 'Professional social media post, high quality, vibrant colors, modern design';
  return style ? `${base}, ${style} style, ${prompt}` : `${base}, ${prompt}`;
}

async function uploadToMinio(buffer: Buffer, mimeType: string): Promise<{ imageUrl: string; minioKey: string }> {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const key = `posts/${Date.now()}-${randomUUID()}.${ext}`;

  const bucketExists = await minioClient.bucketExists(env.MINIO_BUCKET);
  if (!bucketExists) {
    await minioClient.makeBucket(env.MINIO_BUCKET);
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${env.MINIO_BUCKET}/*`] }],
    };
    await minioClient.setBucketPolicy(env.MINIO_BUCKET, JSON.stringify(policy));
  }

  await minioClient.putObject(env.MINIO_BUCKET, key, buffer, buffer.length, { 'Content-Type': mimeType });

  return { imageUrl: `${env.MINIO_PUBLIC_URL}/${env.MINIO_BUCKET}/${key}`, minioKey: key };
}

// ─── Gemini provider ──────────────────────────────────────────────────────────

function mapAspectRatioGemini(ratio?: string): string {
  const map: Record<string, string> = { '1:1': '1:1', '9:16': '9:16', '4:5': '3:4' };
  return map[ratio || '1:1'] || '1:1';
}

async function generateImageGemini(params: GenerateImageParams): Promise<GenerateImageResult> {
  const apiKey = await getSetting('NANO_BANANA_API_KEY');
  if (!apiKey) throw new Error('Google Gemini API Key nao configurada — adicione nas Configuracoes');

  const enrichedPrompt = enrichPrompt(params.prompt, params.style);
  const model = 'gemini-3.1-flash-image-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: `Generate an image: ${enrichedPrompt}` }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: mapAspectRatioGemini(params.aspectRatio) },
    },
  });

  let response: globalThis.Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (response.ok || (response.status !== 503 && response.status !== 429)) break;
    console.log(`[Gemini] ${response.status} on attempt ${attempt + 1}, retrying in ${(attempt + 1) * 5}s...`);
    await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
  }

  if (!response!.ok) {
    const errorText = await response!.text();
    throw new Error(`Gemini API error ${response!.status}: ${errorText}`);
  }

  const data = (await response!.json()) as any;
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart) throw new Error('Nenhuma imagem gerada pelo Gemini API');

  const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  if (imageBuffer.length < 1000) throw new Error('Imagem gerada muito pequena, possivelmente invalida');

  return uploadToMinio(imageBuffer, imagePart.inlineData.mimeType);
}

// ─── Freepik provider ─────────────────────────────────────────────────────────

function mapAspectRatioFreepik(ratio?: string): string {
  const map: Record<string, string> = {
    '1:1': 'square_1_1',
    '9:16': 'social_story_9_16',
    '4:5': 'social_post_4_5',
  };
  return map[ratio || '1:1'] || 'square_1_1';
}

async function generateImageFreepik(params: GenerateImageParams): Promise<GenerateImageResult> {
  const apiKey = await getSetting('FREEPIK_API_KEY');
  if (!apiKey) throw new Error('Freepik API Key nao configurada — adicione nas Configuracoes');

  // Step 1: Submit generation task
  const submitRes = await fetch('https://api.freepik.com/v1/ai/mystic', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-freepik-api-key': apiKey,
    },
    body: JSON.stringify({
      prompt: enrichPrompt(params.prompt, params.style),
      model: 'realism',
      resolution: '2k',
      aspect_ratio: mapAspectRatioFreepik(params.aspectRatio),
    }),
  });

  if (!submitRes.ok) {
    const errorText = await submitRes.text();
    throw new Error(`Freepik API error ${submitRes.status}: ${errorText}`);
  }

  const submitData = (await submitRes.json()) as any;
  const taskId = submitData?.data?.task_id;
  if (!taskId) throw new Error('Freepik nao retornou task_id');

  console.log(`[Freepik] Task criada: ${taskId}`);

  // Step 2: Poll until COMPLETED (max 45s)
  const maxAttempts = 15;
  const pollInterval = 3000;
  let cdnUrl: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const pollRes = await fetch(`https://api.freepik.com/v1/ai/mystic/${taskId}`, {
      headers: { 'x-freepik-api-key': apiKey },
    });

    if (!pollRes.ok) {
      console.warn(`[Freepik] Poll error ${pollRes.status} on attempt ${attempt + 1}`);
      continue;
    }

    const pollData = (await pollRes.json()) as any;
    const status = pollData?.data?.status;
    console.log(`[Freepik] Status: ${status} (attempt ${attempt + 1}/${maxAttempts})`);

    if (status === 'FAILED') throw new Error('Freepik: geracao de imagem falhou');

    if (status === 'COMPLETED') {
      const generated = pollData?.data?.generated;
      if (Array.isArray(generated) && generated.length > 0) {
        cdnUrl = generated[0];
        break;
      }
      throw new Error('Freepik: task concluida mas sem imagens no resultado');
    }
  }

  if (!cdnUrl) throw new Error('Freepik: timeout ao aguardar geracao da imagem (45s)');

  // Step 3: Download from Freepik CDN and upload to MinIO
  console.log(`[Freepik] Baixando imagem do CDN: ${cdnUrl}`);
  const imgRes = await fetch(cdnUrl);
  if (!imgRes.ok) throw new Error(`Freepik: erro ao baixar imagem do CDN (${imgRes.status})`);

  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await imgRes.arrayBuffer();
  const imageBuffer = Buffer.from(arrayBuffer);

  return uploadToMinio(imageBuffer, contentType.split(';')[0].trim());
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const provider = (await getSetting('IMAGE_PROVIDER')) || 'gemini';

  console.log(`[ImageGen] Provider: ${provider}`);

  if (provider === 'freepik') {
    return generateImageFreepik(params);
  }

  return generateImageGemini(params);
}
