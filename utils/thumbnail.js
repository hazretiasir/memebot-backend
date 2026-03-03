const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const s3Client = require('../config/aws');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Generate a thumbnail from a video buffer.
 * Writes video to temp file, extracts frame at 1s, uploads to S3.
 * Returns the S3/CloudFront thumbnail URL.
 */
async function generateAndUploadThumbnail(videoBuffer, videoMimetype) {
    const tmpDir = os.tmpdir();
    const ext = videoMimetype.split('/')[1] || 'mp4';
    const tmpVideoPath = path.join(tmpDir, `${uuidv4()}.${ext}`);
    const tmpThumbPath = path.join(tmpDir, `${uuidv4()}.jpg`);

    try {
        // Write video buffer to temp file
        fs.writeFileSync(tmpVideoPath, videoBuffer);

        // Extract frame at 1 second (fallback to 0s if video shorter)
        await new Promise((resolve, reject) => {
            ffmpeg(tmpVideoPath)
                .screenshots({
                    timestamps: ['00:00:01.000'],
                    filename: path.basename(tmpThumbPath),
                    folder: tmpDir,
                    size: '480x?', // 480px wide, auto height
                })
                .on('end', resolve)
                .on('error', (err) => {
                    // If 1s seek fails (very short video), try at 0s
                    ffmpeg(tmpVideoPath)
                        .screenshots({
                            timestamps: ['00:00:00.001'],
                            filename: path.basename(tmpThumbPath),
                            folder: tmpDir,
                            size: '480x?',
                        })
                        .on('end', resolve)
                        .on('error', reject);
                });
        });

        // Read thumbnail file
        const thumbBuffer = fs.readFileSync(tmpThumbPath);
        const thumbKey = `thumbnails/${uuidv4()}.jpg`;

        // Upload thumbnail to S3
        await s3Client.send(
            new PutObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: thumbKey,
                Body: thumbBuffer,
                ContentType: 'image/jpeg',
            })
        );

        // Build URL
        const cf = process.env.CLOUDFRONT_DOMAIN;
        const thumbUrl = cf
            ? `${cf}/${thumbKey}`
            : `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${thumbKey}`;

        return { thumbUrl, thumbKey, thumbBuffer };
    } finally {
        // Clean up temp files
        try { fs.unlinkSync(tmpVideoPath); } catch (_) { }
        try { fs.unlinkSync(tmpThumbPath); } catch (_) { }
    }
}

module.exports = { generateAndUploadThumbnail };
