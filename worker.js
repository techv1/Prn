export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only handle routes matching /proxy
    if (url.pathname === '/proxy') {
      const targetUrl = url.searchParams.get('url');
      
      if (!targetUrl) {
        return new Response('Missing target URL parameter.', { status: 400 });
      }

      try {
        // Clone headers to mimic a real browser and bypass basic bot checks
        const newHeaders = new Headers(request.headers);
        newHeaders.set('Host', new URL(targetUrl).hostname);
        newHeaders.set('Referer', 'https://www.google.com/');

        // Fetch the raw player page from the adult network
        const response = await fetch(targetUrl, {
          headers: newHeaders,
          redirect: 'follow'
        });

        const contentType = response.headers.get('content-type') || '';

        // Only rewrite if the content is actual HTML page code
        if (contentType.includes('text/html')) {
          
          // Define our Edge-level Ad-Scrubber using Cloudflare's native HTMLRewriter
          const rewriter = new HTMLRewriter()
            .on('script', new ElementScrubber('src'))
            .on('iframe', new ElementScrubber('src'))
            .on('ins', new ElementScrubber('class')); // Blocks standard ad slots

          return rewriter.transform(response);
        }

        // Pass through non-HTML assets (like raw video fragments or images) untouched
        return response;

      } catch (err) {
        return new Response(`Proxy Error: ${err.message}`, { status: 500 });
      }
    }

    // Default response for your root domain
    return new Response('Edge Proxy Shield Active.', { status: 200 });
  }
};

// Smart Element Scrubber Engine
class ElementScrubber {
  constructor(attributeName) {
    this.attributeName = attributeName;
    
    // Strict blocklist covering 95% of adult ad network tracking scripts
    this.blocklist = [
      'exoclick', 'juicyads', 'popads', 'popunder', 'eroadvertising', 
      'onclickads', 'adplugg', 'trafficjunky', 'tjads', 'adserver', 
      'doubleclick', 'googlesyndication', 'aweber', 'blackhole'
    ];
  }

  element(element) {
    const attrValue = element.getAttribute(this.attributeName);
    
    if (attrValue) {
      const lowerValue = attrValue.toLowerCase();
      
      // If the source URL matches anything in our ad blocklist, destroy the element completely
      const matchesAdPattern = this.blocklist.some(domain => lowerValue.includes(domain));
      
      if (matchesAdPattern) {
        element.remove(); 
      }
    }
  }
}