const youtubedl = require('youtube-dl-exec');

async function test() {
    console.log('Fetching profile data...');
    try {
        const output = await youtubedl('https://twitter.com/yalcdb/media', {
            dumpSingleJson: true,
            flatPlaylist: true,
            playlistEnd: 5 // Just get 5 for testing
        });

        console.log(JSON.stringify(output.entries, null, 2));
    } catch (e) {
        console.error(e);
    }
}
test();
