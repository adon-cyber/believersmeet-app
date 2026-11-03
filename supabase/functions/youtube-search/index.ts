import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { q } = await req.json()
    if (!q || typeof q !== 'string' || q.trim() === '') {
      return new Response(
        JSON.stringify({ error: 'Search query "q" is required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const apiKey = Deno.env.get('YOUTUBE_API_KEY')
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'YouTube API key is not configured on the server.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q.trim())}&key=${apiKey}`
    const ytRes = await fetch(url)
    const ytData = await ytRes.json()

    if (!ytRes.ok) {
      return new Response(
        JSON.stringify({ error: ytData.error?.message || 'Failed to fetch from YouTube API' }),
        { status: ytRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const items = (ytData.items || []).map((item: any) => ({
      videoId: item.id?.videoId,
      title: item.snippet?.title,
      description: item.snippet?.description,
      channelTitle: item.snippet?.channelTitle,
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url
    })).filter((item: any) => item.videoId);

    return new Response(
      JSON.stringify(items),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
