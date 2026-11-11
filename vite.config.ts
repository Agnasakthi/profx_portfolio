import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import http from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Streams public Google Drive video files over the same origin with byte-range support.
 * Google Drive blocks direct browser <video> tags via hotlink Referer checks and
 * Cross-Origin-Resource-Policy: same-site headers; proxying server-side without
 * Referer/Origin headers enables instant inline 206 MP4 playback.
 */
function googleDriveMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  const urlPath = req.url?.split('?')[0] ?? '';
  const match = /^\/api\/drive-video\/([A-Za-z0-9_-]+)$/.exec(urlPath);
  if (!match) {
    next();
    return;
  }

  const fileId = match[1];
  const initialUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  const forwardStream = (targetUrl: string, redirectsLeft: number) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'http:' ? http : https;
    const upstreamHeaders: Record<string, string> = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    };
    if (typeof req.headers.range === 'string') {
      upstreamHeaders.range = req.headers.range;
    }

    const upstreamReq = transport.request(
      parsed,
      { method, headers: upstreamHeaders },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const location = upstreamRes.headers.location;

        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          upstreamRes.resume();
          const nextUrl = new URL(location, parsed).toString();
          forwardStream(nextUrl, redirectsLeft - 1);
          return;
        }

        const rawType = String(upstreamRes.headers['content-type'] ?? '');
        if (rawType.includes('text/html')) {
          upstreamRes.resume();
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Google Drive returned HTML instead of video bytes.');
          }
          return;
        }

        const resolvedType =
          !rawType || rawType.includes('octet-stream') ? 'video/mp4' : rawType;

        res.statusCode = status;
        res.setHeader('Content-Type', resolvedType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        if (upstreamRes.headers['content-length']) {
          res.setHeader('Content-Length', upstreamRes.headers['content-length']);
        }
        if (upstreamRes.headers['content-range']) {
          res.setHeader('Content-Range', upstreamRes.headers['content-range']);
        }

        if (method === 'HEAD') {
          upstreamRes.resume();
          res.end();
          return;
        }

        upstreamRes.on('error', () => {
          if (!res.destroyed) res.destroy();
        });
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(err.message);
      } else if (!res.destroyed) {
        res.destroy();
      }
    });

    res.on('close', () => {
      upstreamReq.destroy();
    });

    upstreamReq.end();
  };

  forwardStream(initialUrl, 5);
}

function googleDriveStreamPlugin(): Plugin {
  return {
    name: 'google-drive-video-stream',
    configureServer(server) {
      server.middlewares.use(googleDriveMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(googleDriveMiddleware);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    googleDriveStreamPlugin(),
  ],
});
