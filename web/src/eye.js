/*
	Das Auge aus der Hero-Section von reputa.xyz, uebernommen am 30.09.2026, als
	Reputa stillgelegt wurde. Shader und Bewegung sind unveraendert; neu ist nur
	die Huelle: es startet als Auge statt als Jade-Kugel (ein Klick schaltet um
	wie im Original), und es rechnet nur, solange es sichtbar ist.

	Reine Darstellung: kein Netz, keine Daten, kein Markup. WebGL2 fehlt oder
	reduzierte Bewegung ist gewuenscht - dann bleibt es aus bzw. steht still.
*/
export function mountEye(cv) {
	if (!cv || cv.dataset.eye === 'on') return;
	const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
	if (!gl) { cv.hidden = true; return; }
	cv.dataset.eye = 'on';
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const vs=`#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
	const fs=`#version 300 es
precision highp float; out vec4 O;
uniform vec2 uRes; uniform vec2 uMouse; uniform float uReveal; uniform float uPupil; uniform float uT; uniform float uSpin; uniform float uBlink;
float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5; } return s; }
mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
vec3 env(vec3 d){
  float up=clamp(d.y*0.5+0.5,0.0,1.0);
  vec3 c=mix(vec3(0.03,0.05,0.06),vec3(0.34,0.44,0.47),up*up);
  float w=smoothstep(0.35,1.0,dot(normalize(d),normalize(vec3(-0.35,0.85,0.40))));
  c+=vec3(1.0,1.0,0.98)*pow(w,3.0)*0.95;
  float w2=smoothstep(0.86,1.0,dot(normalize(d),normalize(vec3(0.45,0.45,0.77))));
  c+=vec3(0.9,1.0,0.96)*w2*0.5; return c; }
vec3 jade(vec3 lp){
  vec2 q=lp.xy; float w=fbm(q*2.0); float m=fbm(q*3.2+w*1.5); float sw=fbm(q*5.0+w*2.5);
  vec3 dark=vec3(0.02,0.18,0.15),mid=vec3(0.11,0.55,0.46),light=vec3(0.50,0.98,0.80);
  vec3 c=mix(dark,mid,smoothstep(0.28,0.68,m));
  c=mix(c,dark*0.8,smoothstep(0.50,0.72,sw)*0.6);
  c=mix(c,light,smoothstep(0.58,0.86,fbm(q*6.5+sw*2.0))*0.6);
  c*=0.95+0.08*noise(q*46.0);
  return c; }
vec3 eyeCol(vec3 lp){
  float s=length(lp.xy);
  vec3 scl=mix(vec3(1.0,1.0,0.995),vec3(0.95,0.93,0.86),smoothstep(0.30,1.0,s));
  scl*=mix(0.74,1.0,clamp(lp.z,0.0,1.0));
  float vn=fbm(lp.xy*6.5+5.0); float vm=smoothstep(0.55,0.96,s)*smoothstep(0.66,0.98,vn);
  scl=mix(scl,vec3(0.82,0.22,0.18),vm*0.42);
  scl+=vec3(0.07,0.015,0.0)*smoothstep(0.60,0.46,s)*0.6;
  scl=mix(scl,scl*vec3(0.90,0.94,1.0),smoothstep(0.5,0.42,s)*0.4);
  scl*=mix(0.72,1.0,smoothstep(0.42,0.50,s));
  scl*=0.95+0.09*noise(lp.xy*54.0);
  scl*=mix(1.0,0.86,smoothstep(0.52,0.43,s));
  float irisR=0.42; float ang=atan(lp.y,lp.x); float rn=clamp(s/irisR,0.0,1.0);
  float ia=ang+uT*0.06+0.02*sin(uT*0.5);
  float warp=fbm(vec2(ia*2.5,rn*2.0)); float fib=fbm(vec2(ia*7.0,rn*3.0)+warp*1.5);
  float crypt=fbm(vec2(ia*14.0,rn*6.0));
  vec3 deepI=vec3(0.04,0.30,0.25),teal=vec3(0.17,0.77,0.69),mint=vec3(0.45,0.97,0.79);
  vec3 iris=mix(deepI,teal,smoothstep(0.10,0.48,rn));
  iris=mix(iris,mint,fib*0.42);
  iris*=0.82+0.32*crypt;
  iris+=mint*0.26*smoothstep(0.16,0.10,abs(rn-0.20));
  iris*=mix(1.0,0.26,smoothstep(0.80,1.0,rn));
  float pupR=mix(0.095,0.225,uPupil);
  iris*=mix(0.5,1.0,smoothstep(pupR,pupR+0.055,s));
  float pupil=smoothstep(pupR,pupR-0.012,s); iris=mix(iris,vec3(0.0),pupil);
  iris+=teal*0.20*smoothstep(pupR+0.03,pupR,s)*(1.0-pupil);
  float im=smoothstep(irisR,irisR-0.006,s);
  vec3 outc=mix(scl,iris,im);
  float edge=smoothstep(0.03,0.0,abs(s-irisR));
  outc+=edge*vec3(-0.05,0.0,0.11);
  return outc; }
void main(){
  vec2 uv=(gl_FragCoord.xy*2.0-uRes)/uRes.y; float aa=2.0/uRes.y; float r=length(uv);
  float mask=smoothstep(1.0,1.0-aa,r); if(mask<=0.0){ O=vec4(0.0); return; }
  float z=sqrt(max(0.0,1.0-r*r)); vec3 N=vec3(uv,z);
  float angY=uSpin + uMouse.x*0.55;
  float angX=-uMouse.y*0.55;
  vec3 lp=rotX(-angX)*(rotY(-angY)*N);
  vec3 albedo=mix(jade(lp), eyeCol(lp), smoothstep(0.4,0.6,uReveal));
  vec3 shN=N; float lid=0.0, lidCast=0.0, crease=0.0;
  if(uBlink>0.001){
	float ly=lp.y, lx=lp.x;
	float h=mix(1.55,0.0,uBlink);
	float alm=1.0-0.45*lx*lx;
	float topEdge=h*alm*0.95-0.06;
	float botEdge=-h*alm*0.72-0.02;
	float upperLid=smoothstep(topEdge,topEdge+0.02,ly);
	float lowerLid=1.0-smoothstep(botEdge-0.02,botEdge,ly);
	lid=max(upperLid,lowerLid);
	bool upLid=upperLid>=lowerLid;
	float dE=upLid?(ly-topEdge):(botEdge-ly);
	float e=(dE-0.05)/0.06; float ridge=exp(-e*e); float slope=-e*ridge;
	float dir=upLid?1.0:-1.0;
	vec3 upV=rotY(angY)*(rotX(angX)*vec3(0.0,1.0,0.0));
	shN=normalize(N+dir*slope*0.9*upV);
	crease=(upLid?smoothstep(0.14,0.0,topEdge-ly):smoothstep(0.10,0.0,ly-botEdge))*(1.0-lid);
	lidCast=smoothstep(0.22,0.0,topEdge-ly)*(1.0-lid)*uBlink;
	vec3 lidCol=jade(lp)*mix(0.72,1.0,smoothstep(0.0,0.14,dE));
	lidCol*=1.0-0.55*smoothstep(0.014,0.0,abs(dE));
	albedo=mix(albedo,lidCol,lid);
  }
  vec3 L=normalize(vec3(-0.42+uMouse.x*0.30,0.52+uMouse.y*0.24,0.82));
  float diff=clamp(dot(shN,L),0.0,1.0);
  vec3 col=albedo*(0.34+0.76*diff);
  float fres=pow(1.0-z,3.0);
  col+=env(reflect(vec3(0.0,0.0,-1.0),N))*(0.12+0.60*fres)*(1.0-0.7*lid);
  col+=vec3(1.0)*pow(clamp(dot(shN,normalize(L+vec3(0,0,1))),0.0,1.0),120.0)*0.7;
  col+=vec3(1.0)*pow(clamp(dot(N,normalize(vec3(-0.3,0.5,0.9))),0.0,1.0),600.0)*0.85*(1.0-0.9*lid);
  col+=fres*vec3(0.4,0.75,0.62)*0.35;
  col*=1.0-0.42*crease-0.5*lidCast;
  col*=mask; O=vec4(col,mask);
}`;
	function sh(t, source) { const s = gl.createShader(t); gl.shaderSource(s, source); gl.compileShader(s); return s; }
	const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
	if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { cv.hidden = true; return; }
	gl.useProgram(pr);
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	const U = (n) => gl.getUniformLocation(pr, n);
	const uRes = U('uRes'), uMouse = U('uMouse'), uReveal = U('uReveal'), uPupil = U('uPupil'), uT = U('uT'), uSpin = U('uSpin'), uBlink = U('uBlink');
	gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);
	let rect = cv.getBoundingClientRect();
	function resize() { const d = Math.min(window.devicePixelRatio || 1, 2); const w = cv.clientWidth || 1, h = cv.clientHeight || 1; cv.width = Math.max(2, Math.round(w * d)); cv.height = Math.max(2, Math.round(h * d)); gl.viewport(0, 0, cv.width, cv.height); rect = cv.getBoundingClientRect(); }
	window.addEventListener('resize', resize); window.addEventListener('scroll', () => { rect = cv.getBoundingClientRect(); }, { passive: true }); resize();
	function render(mx, my, reveal, pupil, tt, sp, bl) { gl.clear(gl.COLOR_BUFFER_BIT); gl.uniform2f(uRes, cv.width, cv.height); gl.uniform2f(uMouse, mx, my); gl.uniform1f(uReveal, reveal); gl.uniform1f(uPupil, pupil); gl.uniform1f(uT, tt); gl.uniform1f(uSpin, sp); gl.uniform1f(uBlink, bl); gl.drawArrays(gl.TRIANGLES, 0, 3); }
	if (reduce) { render(0, 0, 1, 0.7, 0, 0, 0); return; }
	let tx = 0, ty = 0, mx = 0, my = 0, pdist = 2, pupil = 0.8, lastMove = performance.now(), reveal = 1, revealT = 1, eye = true, t = 0, spin = 0, spinTarget = 0, blink = 0, blinkStart = -1;
	const clamp = (v) => Math.max(-1, Math.min(1, v));
	window.addEventListener('pointermove', (e) => { const halfH = (rect.height / 2) || 1; const nx = (e.clientX - (rect.left + rect.width / 2)) / halfH, ny = (e.clientY - (rect.top + rect.height / 2)) / halfH; tx = clamp(nx / 1.6); ty = clamp(-ny / 1.6); pdist = Math.hypot(nx, ny); lastMove = performance.now(); }, { passive: true });
	window.addEventListener('blur', () => { pdist = 2.4; });
	cv.addEventListener('click', () => { eye = !eye; revealT = eye ? 1 : 0; spinTarget += Math.PI * 2; });
	function scheduleBlink() { setTimeout(() => { if (reveal > 0.55 && blinkStart < 0) blinkStart = performance.now(); const dbl = Math.random() < 0.18; setTimeout(scheduleBlink, dbl ? 280 : 0); }, 2200 + Math.random() * 2600); }
	scheduleBlink();
	// Nur rechnen, solange das Auge zu sehen ist: im Viewport und im sichtbaren Tab.
	let inView = true, running = false;
	function frame(now) {
		if (!inView || document.hidden) { running = false; return; }
		t += 0.016; const idle = (now - lastMove) > 3000; if (idle) { tx = Math.sin(t * 0.45) * 0.6; ty = Math.cos(t * 0.38) * 0.36; } mx += (tx - mx) * 0.07; my += (ty - my) * 0.07; reveal += (revealT - reveal) * 0.11; spin += (spinTarget - spin) * 0.09; const pt = idle ? 0.9 : clamp(pdist / 1.5, 0, 1); pupil += (pt - pupil) * 0.12;
		if (blinkStart >= 0) { const dt = now - blinkStart, closeT = 85, openT = 160; if (dt < closeT) { const p = dt / closeT; blink = p * p; } else if (dt < closeT + openT) { const q = (dt - closeT) / openT; blink = 1 - q * q * (3 - 2 * q); } else { blink = 0; blinkStart = -1; } } else blink = 0;
		render(mx, my, reveal, pupil, t, spin, Math.max(0, blink)); requestAnimationFrame(frame);
	}
	function start() { if (!running && inView && !document.hidden) { running = true; requestAnimationFrame(frame); } }
	new IntersectionObserver((eintraege) => { inView = eintraege.some((e) => e.isIntersecting); if (inView) { resize(); start(); } }).observe(cv);
	document.addEventListener('visibilitychange', start);
	start();
}
