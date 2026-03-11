const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
ffmpeg.setFfmpegPath(ffmpegPath);

const url = "https://video.twimg.com/amplify_video/1831776859571736576/pl/oNigv008Lw_5qIu3.m3u8?tag=16&v=cf4";

const tempFile = path.join(os.tmpdir(), `MemeBot_Audio_${Date.now()}.mp3`);
console.log(`[Downloader Proxy] Transcoding Audio to TEMP MP3 -> ${url.substring(0, 50)}...`);

ffmpeg(url)
    .noVideo()
    .audioCodec('libmp3lame')
    .audioBitrate('128k')
    .format('mp3')
    .on('error', (err) => {
        console.error('[FFmpeg Proxy Error]:', err.message);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    })
    .on('end', () => {
        console.log('[Downloader Proxy] Transcoding complete.');
        console.log('File size:', fs.statSync(tempFile).size);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    })
    .save(tempFile);
