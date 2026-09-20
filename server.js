const express = require('express');
const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOMAIN = process.env.DOMAIN || 'localhost';
const RTMP_PORT = 1935;
const HTTP_PORT = process.env.HTTP_PORT || 3001;
const STREAM_KEY = process.env.STREAM_KEY || 'live';

const app = express();

app.get('/72b1a116-2c2d-411f-abe4-fd96859985a9', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

app.use('/bedc6c0f-76ce-45c1-a0d7-44d60350e9db', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}, (req, res, next) => {
  const filePath = path.join(__dirname, 'media', req.path);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  next();
}, express.static(path.join(__dirname, 'media'), { etag: false, lastModified: false }));

app.use((req, res) => {
  res.socket?.destroy();
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP server: http://${DOMAIN}:${HTTP_PORT}`);
  console.log(`OBS RTMP URL: rtmp://${DOMAIN}:${RTMP_PORT}/live`);
  console.log(`OBS Stream Key: ${STREAM_KEY}`);
  console.log(`Player: http://${DOMAIN}:${HTTP_PORT}/live`);
});

const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const HLS_DIR = path.join(__dirname, 'media');
const ffmpegProcesses = {};

fs.rmSync(path.join(__dirname, 'media'), { recursive: true, force: true });
fs.mkdirSync(path.join(__dirname, 'media'), { recursive: true });

const nms = new NodeMediaServer({
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8888,
    mediaroot: path.join(__dirname, 'media'),
    allow_origin: '*',
  },
});

nms.on('prePublish', (id, StreamPath) => {
  const key = StreamPath.split('/').pop();
  const outDir = path.join(HLS_DIR, key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'hi'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'mid'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'lo'), { recursive: true });

  const ff = spawn(FFMPEG, [
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}${StreamPath}`,

    // hd+
    '-map', '0:v', '-map', '0:a',
    '-c:v', 'copy', '-c:a', 'copy',
    '-f', 'hls',
    '-hls_time', '6', '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+discont_start+split_by_time+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'hi', 'seg%d.ts'),
    path.join(outDir, 'hi', 'index.m3u8'),

    // 1280x720
    '-map', '0:v', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency', '-b:v', '1500k', '-vf', 'scale=1280:720',
    '-c:a', 'aac', '-b:a', '128k',
    '-force_key_frames', 'expr:gte(t,n_forced*6)',
    '-f', 'hls',
    '-hls_time', '6', '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+discont_start+split_by_time+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'mid', 'seg%d.ts'),
    path.join(outDir, 'mid', 'index.m3u8'),

    // 854x480
    '-map', '0:v', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency', '-b:v', '800k', '-vf', 'scale=854:480',
    '-c:a', 'aac', '-b:a', '96k',
    '-force_key_frames', 'expr:gte(t,n_forced*6)',
    '-f', 'hls',
    '-hls_time', '6', '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+discont_start+split_by_time+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'lo', 'seg%d.ts'),
    path.join(outDir, 'lo', 'index.m3u8'),
  ]);

  ff.stderr.on('data', (d) => process.stdout.write(d));
  ff.on('close', () => delete ffmpegProcesses[id]);
  ffmpegProcesses[id] = ff;

  // playlist
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
    'hi/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1628000,RESOLUTION=1280x720',
    'mid/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=854x480',
    'lo/index.m3u8',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'master.m3u8'), master);
});

nms.on('donePublish', (id) => {
  if (ffmpegProcesses[id]) {
    ffmpegProcesses[id].kill();
    delete ffmpegProcesses[id];
  }
});

nms.run();
