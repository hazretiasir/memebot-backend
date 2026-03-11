const youtubedl = require('youtube-dl-exec');

async function test() {
    const url = 'https://x.com/yalcdb/status/1831776953331163479'; // example video
    console.log('Fetching metadata for:', url);
    const info = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        format: 'bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio',
    });

    console.log('--- RESULTS ---');
    console.log('Title:', info.title);
    console.log('Direct URL:', info.url?.substring(0, 100) + '...');

    let preferredUrl = info.url;
    if (!preferredUrl && Array.isArray(info.formats)) {
        const withUrls = info.formats.filter((f) => !!f.url);
        const preferred = withUrls.filter((f) => f.vcodec === 'none').pop();
        preferredUrl = preferred?.url ?? withUrls.pop()?.url;
        console.log('Fallback URL from formats:', preferredUrl?.substring(0, 100) + '...');
    }

    console.log('Final URL to download:', preferredUrl?.substring(0, 100) + '...');

    let ext = 'm4a';
    if (preferredUrl) {
        if (preferredUrl.includes('.mp3')) ext = 'mp3';
        else if (preferredUrl.includes('.webm')) ext = 'webm';
        else if (preferredUrl.includes('.m4a')) ext = 'm4a';
        else if (preferredUrl.includes('.aac')) ext = 'aac';
    }
    console.log('Detected EXT:', ext);
}

test().catch(console.error);
