export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith('/admin')) {
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const allowed = ['42.108.85.0/24', '2402:3a80:430c:e6cd::/64'];
      
      const ipv4 = ip.startsWith('42.108.85.');
      const ipv6 = ip.startsWith('2402:3a80:430c:e6cd:');
      
      if (!ipv4 && !ipv6) {
        return new Response('Access Denied', { status: 403 });
      }
    }
    
    return env.ASSETS.fetch(request);
  }
}
