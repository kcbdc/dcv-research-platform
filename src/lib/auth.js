function unauthorized(status=401,error='unauthorized'){return new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json'}});}
export function secureEqual(a,b){
  const x=new TextEncoder().encode(String(a??'')),y=new TextEncoder().encode(String(b??''));
  let diff=x.length^y.length,n=Math.max(x.length,y.length);for(let i=0;i<n;i++)diff|=(x[i]||0)^(y[i]||0);return diff===0;
}
export function requireAdmin(request, env) {
  const expected=String(env.ADMIN_TOKEN||'').trim();
  if(!expected) return unauthorized(503,'admin_auth_not_configured');
  const auth=request.headers.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):request.headers.get('x-admin-token')||'';
  if(!secureEqual(token,expected))return unauthorized();
  return null;
}
export function routeAccessClass(parts,method){
  if(parts[0]!=='api')return 'asset';
  if(parts[1]==='health')return 'public';
  if(parts[1]==='human-login'&&method==='POST')return 'public-human-bootstrap';
  if(parts[1]==='projects'&&parts[2]){
    if(['reviewer-login','reviewer-quiz'].includes(parts[3])&&method==='POST')return 'public-human-bootstrap';
    if(['reviewer-trials','reviewer-observations'].includes(parts[3])&&method==='POST')return 'human-session';
  }
  return 'admin';
}
