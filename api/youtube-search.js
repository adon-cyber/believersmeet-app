export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { q } = req.query || {};

        if (!q || typeof q !== 'string' || !q.trim()) {
            return res.status(400).json({ error: 'Missing or invalid search query parameter "q"' });
        }

        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey) {
            console.error('YOUTUBE_API_KEY environment variable is not set');
            return res.status(500).json({ error: 'YouTube API key is not configured on the server' });
        }

        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=12&type=video&q=${encodeURIComponent(q.trim())}&key=${apiKey}`;

        const ytResponse = await fetch(url);
        const ytData = await ytResponse.json();

        if (!ytResponse.ok) {
            console.error('YouTube API Error Response:', ytData);
            const errorMessage = ytData.error?.message || 'Failed to fetch from YouTube API';
            return res.status(ytResponse.status || 502).json({ error: errorMessage });
        }

        const items = ytData.items || [];
        const results = items.map(item => {
            const videoId = item.id?.videoId || (typeof item.id === 'string' ? item.id : '');
            const snippet = item.snippet || {};
            const thumbnails = snippet.thumbnails || {};
            const thumbnail = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';

            return {
                id: videoId,
                title: snippet.title || '',
                channelTitle: snippet.channelTitle || '',
                thumbnail: thumbnail,
                publishedAt: snippet.publishedAt || ''
            };
        }).filter(video => video.id);

        return res.status(200).json(results);

    } catch (error) {
        console.error('YouTube search proxy error:', error);
        return res.status(500).json({ error: error.message || 'Internal server error during YouTube search' });
    }
}
